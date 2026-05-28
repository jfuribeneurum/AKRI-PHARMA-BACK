import crypto from 'node:crypto';

import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { incrementSignatureCount } from './metrics.service.js';
import { HttpError } from '../utils/http-error.js';
import { verifyPassword, hashPassword } from '../utils/password.js';
import { writeAudit, buildAuditFromUser } from './audit.service.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function buildHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function buildEnvelopeSignature(secret, payloadHash) {
  return crypto.createHmac('sha256', `${secret}|${env.SIGNATURE_HASH_SALT}`).update(payloadHash).digest('hex');
}

async function getSignatureProfileRecord(userId) {
  const [profile] = await query(
    `SELECT id_perfil_firma, id_usuario, alias_certificado, emisor_certificado, serial_certificado,
            huella_certificado, email_firma, pin_hash, exige_segundo_factor, firma_visible_nombre,
            firma_visible_cargo, firma_visible_imagen, es_activo, fecha_modificacion
     FROM firmas_avanzadas_perfiles
     WHERE id_usuario = ?
     ORDER BY id_perfil_firma DESC
     LIMIT 1`,
    [userId]
  );
  return profile ?? null;
}

function presentSignatureProfile(profile) {
  if (!profile) return null;
  return {
    id_perfil_firma: profile.id_perfil_firma,
    id_usuario: profile.id_usuario,
    alias_certificado: profile.alias_certificado,
    emisor_certificado: profile.emisor_certificado,
    serial_certificado: profile.serial_certificado,
    huella_certificado: profile.huella_certificado,
    email_firma: profile.email_firma,
    exige_segundo_factor: Boolean(profile.exige_segundo_factor),
    firma_visible_nombre: profile.firma_visible_nombre,
    firma_visible_cargo: profile.firma_visible_cargo,
    firma_visible_imagen: profile.firma_visible_imagen,
    es_activo: Boolean(profile.es_activo),
    pin_configurado: Boolean(profile.pin_hash),
    fecha_modificacion: profile.fecha_modificacion ? new Date(profile.fecha_modificacion).toISOString() : null
  };
}

export async function getSignatureProfile(userId) {
  return presentSignatureProfile(await getSignatureProfileRecord(userId));
}

export async function upsertSignatureProfile(payload, user) {
  const pinHash = payload.pin ? hashPassword(payload.pin) : null;
  const existing = await getSignatureProfileRecord(user.sub);

  if (existing) {
    await query(
      `UPDATE firmas_avanzadas_perfiles
       SET alias_certificado = ?, emisor_certificado = ?, serial_certificado = ?, huella_certificado = ?,
           email_firma = ?, pin_hash = COALESCE(?, pin_hash), exige_segundo_factor = ?,
           firma_visible_nombre = ?, firma_visible_cargo = ?, firma_visible_imagen = ?, es_activo = ?,
           metadata = ?, fecha_modificacion = NOW()
       WHERE id_perfil_firma = ?`,
      [
        payload.alias_certificado,
        payload.emisor_certificado ?? null,
        payload.serial_certificado ?? null,
        payload.huella_certificado ?? null,
        payload.email_firma ?? null,
        pinHash,
        payload.exige_segundo_factor ? 1 : 0,
        payload.firma_visible_nombre ?? null,
        payload.firma_visible_cargo ?? null,
        payload.firma_visible_imagen ?? null,
        payload.es_activo === false ? 0 : 1,
        JSON.stringify(payload.metadata ?? {}),
        existing.id_perfil_firma
      ]
    );
  } else {
    await query(
      `INSERT INTO firmas_avanzadas_perfiles
       (id_usuario, alias_certificado, emisor_certificado, serial_certificado, huella_certificado,
        email_firma, pin_hash, exige_segundo_factor, firma_visible_nombre, firma_visible_cargo,
        firma_visible_imagen, es_activo, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.sub,
        payload.alias_certificado,
        payload.emisor_certificado ?? null,
        payload.serial_certificado ?? null,
        payload.huella_certificado ?? null,
        payload.email_firma ?? null,
        pinHash,
        payload.exige_segundo_factor ? 1 : 0,
        payload.firma_visible_nombre ?? null,
        payload.firma_visible_cargo ?? null,
        payload.firma_visible_imagen ?? null,
        payload.es_activo === false ? 0 : 1,
        JSON.stringify(payload.metadata ?? {})
      ]
    );
  }

  const profile = presentSignatureProfile(await getSignatureProfileRecord(user.sub));
  await writeAudit(undefined, buildAuditFromUser(user, {
    modulo: 'SEGURIDAD',
    submodulo: 'FIRMAS',
    accion: existing ? 'UPDATE' : 'INSERT',
    descripcion: 'Perfil de firma avanzada actualizado',
    datosNuevos: profile,
    metadata: { profile_id: profile?.id_perfil_firma ?? null }
  }));
  return profile;
}

export async function signProcess(payload, user) {
  const rawProfile = await getSignatureProfileRecord(user.sub);
  const profile = presentSignatureProfile(rawProfile);
  if (!profile?.es_activo) {
    throw new HttpError(400, 'El usuario no tiene un perfil de firma avanzada activo');
  }

  const [account] = await query('SELECT password_hash FROM usuarios WHERE id_usuario = ?', [user.sub]);
  if (!account) {
    throw new HttpError(404, 'Usuario firmante no encontrado');
  }

  const verificationSource = rawProfile?.pin_hash ?? (env.SIGNATURE_ENFORCE_PIN ? null : account.password_hash);
  if (!verificationSource) {
    throw new HttpError(400, 'Debe configurar un PIN de firma para habilitar la firma avanzada');
  }
  if (!verifyPassword(payload.secret, verificationSource)) {
    throw new HttpError(401, 'Secreto de firma inválido');
  }

  const signedPayload = {
    request_id: payload.request_id ?? null,
    modulo: payload.modulo,
    submodulo: payload.submodulo ?? null,
    referencia_tipo: payload.referencia_tipo ?? null,
    referencia_id: payload.referencia_id ?? null,
    descripcion: payload.descripcion ?? null,
    evidencia: payload.evidencia ?? null,
    actor: {
      id_usuario: user.sub,
      perfil: user.role,
      id_sede: user.id_sede ?? null
    },
    signed_at: new Date().toISOString()
  };

  const payloadHash = buildHash(signedPayload);
  const envelopeSignature = buildEnvelopeSignature(payload.secret, payloadHash);

  const result = await query(
    `INSERT INTO firmas_transacciones
     (request_id, modulo, submodulo, referencia_tipo, referencia_id, descripcion,
      payload_resumen_json, payload_hash_sha256, firma_hmac_sha256,
      firmado_por_usuario_id, perfil_nombre, id_sede, certificado_alias,
      factor_validado, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'firmada')`,
    [
      payload.request_id ?? null,
      payload.modulo,
      payload.submodulo ?? null,
      payload.referencia_tipo ?? null,
      payload.referencia_id ?? null,
      payload.descripcion ?? null,
      JSON.stringify(signedPayload),
      payloadHash,
      envelopeSignature,
      user.sub,
      user.role,
      user.id_sede ?? null,
      profile.alias_certificado,
      rawProfile?.pin_hash ? 'pin' : 'password'
    ]
  );

  incrementSignatureCount();

  const [row] = await query(
    `SELECT id_firma_transaccion, fecha_firma, estado
     FROM firmas_transacciones
     WHERE id_firma_transaccion = ?`,
    [result.insertId]
  );

  await writeAudit(undefined, buildAuditFromUser(user, {
    modulo: 'SEGURIDAD',
    submodulo: 'FIRMAS',
    accion: 'APROBACION',
    descripcion: `Firma avanzada registrada para ${payload.modulo}`,
    idRegistro: String(result.insertId),
    datosNuevos: { payload_hash_sha256: payloadHash, referencia_tipo: payload.referencia_tipo, referencia_id: payload.referencia_id },
    metadata: { request_id: payload.request_id ?? null, factor: rawProfile?.pin_hash ? 'pin' : 'password' }
  }));

  return {
    id_firma_transaccion: row?.id_firma_transaccion ?? result.insertId,
    fecha_firma: row?.fecha_firma ? new Date(row.fecha_firma).toISOString() : new Date().toISOString(),
    estado: row?.estado ?? 'firmada',
    payload_hash_sha256: payloadHash,
    certificado_alias: profile.alias_certificado,
    firmado_por: user.name ?? user.username,
    perfil: user.role,
    request_id: payload.request_id ?? null
  };
}

export async function listRecentSignatures(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit ?? 20), 100));
  const rows = await query(
    `SELECT id_firma_transaccion, request_id, modulo, submodulo, referencia_tipo, referencia_id,
            descripcion, payload_hash_sha256, firmado_por_usuario_id, perfil_nombre,
            certificado_alias, factor_validado, estado, fecha_firma
     FROM firmas_transacciones
     ORDER BY fecha_firma DESC
     LIMIT ${safeLimit}`
  );
  return rows.map((row) => ({
    ...row,
    fecha_firma: row.fecha_firma ? new Date(row.fecha_firma).toISOString() : null
  }));
}
