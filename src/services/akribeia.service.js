import axios from 'axios';
import { env } from '../config/env.js';

// Integración con AkribeIA (backend de facturación electrónica DIAN) vía
// API key de servicio (header X-Api-Key) — mismo espíritu que
// akripos-back/src/lib/akribeia.mjs. Nunca se usa JWT de usuario acá.
const API_PREFIX = '/api/integraciones/pos';

function client() {
  if (!env.AKRIBEIA_BASE_URL || !env.AKRIBEIA_API_KEY) {
    throw new Error('Integración AkribeIA no configurada (falta AKRIBEIA_BASE_URL/AKRIBEIA_API_KEY en .env)');
  }
  return axios.create({
    baseURL: env.AKRIBEIA_BASE_URL,
    timeout: env.AKRIBEIA_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': env.AKRIBEIA_API_KEY }
  });
}

function unwrapError(error) {
  const status = error.response?.status ?? 500;
  const data = error.response?.data ?? { error: error.message };
  const message = data?.error || data?.message || error.message;
  const wrapped = new Error(message);
  wrapped.status = status;
  wrapped.details = data;
  return wrapped;
}

/** Centros de costo, sedes y cuentas PUC de AkribeIA (mismo endpoint que usa AKRIPOS). */
export async function obtenerOpciones() {
  try {
    const { data } = await client().get(`${API_PREFIX}/opciones`);
    return data;
  } catch (error) {
    throw unwrapError(error);
  }
}

/** EPS y contratos de salud activos de la empresa dueña de la API key. */
export async function obtenerOpcionesSalud() {
  try {
    const { data } = await client().get(`${API_PREFIX}/opciones-salud`);
    return data;
  } catch (error) {
    throw unwrapError(error);
  }
}

/** Cotización previa (sin crear factura) — para mostrar el subtotal/copago estimado antes de confirmar. */
export async function cotizarFacturaSalud(body) {
  try {
    const { data } = await client().post(`${API_PREFIX}/facturas-salud/cotizar`, body);
    return data;
  } catch (error) {
    throw unwrapError(error);
  }
}

/** Crea (y, según el contrato, envía a la DIAN) la factura de salud de una dispensación. */
export async function crearFacturaSalud(body) {
  try {
    const { data } = await client().post(`${API_PREFIX}/facturas-salud`, body);
    return data;
  } catch (error) {
    throw unwrapError(error);
  }
}

/** Reimprime (regenera en vivo) el PDF/tirilla de la factura al paciente y trae las notas crédito/débito ya emitidas. */
export async function obtenerDocumentosSalud({ factura_id, external_ref } = {}) {
  try {
    const params = factura_id ? { factura_id } : { external_ref };
    const { data } = await client().get(`${API_PREFIX}/facturas-salud/documentos`, { params });
    return data;
  } catch (error) {
    throw unwrapError(error);
  }
}

/** Anula (nota crédito) el cargo al paciente de una factura de salud ya emitida. */
export async function crearNotaCreditoSalud(body) {
  try {
    const { data } = await client().post(`${API_PREFIX}/facturas-salud/nota-credito`, body);
    return data;
  } catch (error) {
    throw unwrapError(error);
  }
}

/** Ajusta al alza (nota débito) el cargo al paciente de una factura de salud ya emitida. */
export async function crearNotaDebitoSalud(body) {
  try {
    const { data } = await client().post(`${API_PREFIX}/facturas-salud/nota-debito`, body);
    return data;
  } catch (error) {
    throw unwrapError(error);
  }
}
