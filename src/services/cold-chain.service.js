import axios from 'axios';
import https from 'node:https';
import { query, withTransaction } from '../config/db.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';

function safeJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value === 'object') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function extractNumeric(raw) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function buildIntegrationHeaders(integration) {
  const headers = {};
  if (integration.auth_tipo === 'bearer' && integration.auth_valor) {
    headers.Authorization = `Bearer ${integration.auth_valor}`;
  }
  if (integration.auth_tipo === 'api_key' && integration.auth_header && integration.auth_valor) {
    headers[integration.auth_header] = integration.auth_valor;
  }
  return headers;
}

function parseResponseItems(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.readings)) {
    return payload.readings;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  if (payload?.reading && typeof payload.reading === 'object') {
    return [payload.reading];
  }
  if (payload && typeof payload === 'object') {
    return [payload];
  }
  return [];
}

function locatePayloadForMap(items, mapping) {
  return items.find((item) => {
    const candidate = String(
      item?.device_id ??
      item?.deviceId ??
      item?.sensor_id ??
      item?.sensorId ??
      item?.id ??
      ''
    ).trim();

    return candidate && candidate === String(mapping.device_id);
  }) ?? (items.length === 1 ? items[0] : null);
}

function readingTimestamp(raw) {
  const candidate = raw?.timestamp ?? raw?.fecha_hora ?? raw?.measured_at ?? raw?.created_at ?? null;
  if (!candidate) {
    return null;
  }
  const date = new Date(candidate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function createAlertIfRequired(connection, equipo, reading, integrationId = null) {
  const outsideRange = Number(reading.temperatura) < Number(equipo.temp_min) || Number(reading.temperatura) > Number(equipo.temp_max);
  if (!outsideRange) {
    return false;
  }

  const tipo = Number(reading.temperatura) > Number(equipo.temp_max) ? 'temp_alta' : 'temp_baja';
  await connection.execute(
    `INSERT INTO alertas_cadena_frio (
      id_equipo, id_integracion, severidad, tipo, descripcion, estado, metadata
    ) VALUES (?, ?, ?, ?, ?, 'abierta', ?)`,
    [
      equipo.id_equipo,
      integrationId,
      'alta',
      tipo,
      `Lectura fuera de rango: ${reading.temperatura}°C`,
      JSON.stringify({
        temp_min: equipo.temp_min,
        temp_max: equipo.temp_max,
        humedad: reading.humedad ?? null,
        device_id: reading.device_id ?? null
      })
    ]
  );

  return true;
}

async function insertReading(connection, payload, userId = null) {
  const [equipmentRows] = await connection.execute(
    `SELECT e.*, s.nombre AS sede_nombre
     FROM equipos_cadena_frio e
     INNER JOIN sedes s ON s.id_sede = e.id_sede
     WHERE e.id_equipo = ? FOR UPDATE`,
    [payload.id_equipo]
  );

  const equipo = equipmentRows[0];
  if (!equipo) {
    throw new HttpError(404, 'Equipo no encontrado');
  }

  const temperatura = extractNumeric(payload.temperatura);
  if (temperatura === null) {
    throw new HttpError(400, 'Temperatura inválida');
  }

  const humedad = extractNumeric(payload.humedad);
  const fueraRango = temperatura < Number(equipo.temp_min) || temperatura > Number(equipo.temp_max);

  const [readingResult] = await connection.execute(
    `INSERT INTO lecturas_cadena_frio (
      id_equipo, id_integracion, device_id_remoto, fecha_hora, fecha_lectura_fuente,
      temperatura, humedad, fuente, id_usuario, fuera_rango, observaciones, payload_json
    ) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.id_equipo,
      payload.id_integracion ?? null,
      payload.device_id_remoto ?? null,
      payload.fecha_lectura_fuente ?? null,
      temperatura,
      humedad,
      payload.fuente ?? 'manual',
      userId ?? null,
      fueraRango,
      payload.observaciones ?? null,
      payload.payload_json ? JSON.stringify(payload.payload_json) : null
    ]
  );

  await createAlertIfRequired(connection, equipo, {
    temperatura,
    humedad,
    device_id: payload.device_id_remoto ?? null
  }, payload.id_integracion ?? null);

  return {
    id_lectura: readingResult.insertId,
    fuera_rango: fueraRango,
    equipo
  };
}

export async function listEquipment() {
  return query(
    `SELECT
        e.*,
        s.nombre AS sede,
        a.nombre AS almacen,
        (
          SELECT COUNT(*)
          FROM termohigrometro_mapeos m
          WHERE m.id_equipo = e.id_equipo AND m.activo = TRUE
        ) AS sensores_mapeados
     FROM equipos_cadena_frio e
     INNER JOIN sedes s ON s.id_sede = e.id_sede
     INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
     ORDER BY s.nombre ASC, e.nombre ASC`
  );
}

export async function listReadings(limit = 150) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 300));
  return query(
    `SELECT
        l.id_lectura,
        l.id_equipo,
        l.id_integracion,
        l.device_id_remoto,
        l.fecha_hora,
        l.fecha_lectura_fuente,
        l.temperatura,
        l.humedad,
        l.fuente,
        l.fuera_rango,
        l.observaciones,
        e.nombre AS equipo,
        e.temp_min,
        e.temp_max,
        s.nombre AS sede,
        i.nombre AS integracion
     FROM lecturas_cadena_frio l
     INNER JOIN equipos_cadena_frio e ON e.id_equipo = l.id_equipo
     INNER JOIN sedes s ON s.id_sede = e.id_sede
     LEFT JOIN termohigrometro_integraciones i ON i.id_integracion = l.id_integracion
     ORDER BY l.fecha_hora DESC
     LIMIT ${safeLimit}`
  );
}

export async function createReading(payload, userId) {
  return withTransaction(async (connection) => insertReading(connection, payload, userId));
}

export async function listAlerts() {
  return query(
    `SELECT
        a.*,
        e.nombre AS equipo,
        s.nombre AS sede,
        i.nombre AS integracion
     FROM alertas_cadena_frio a
     INNER JOIN equipos_cadena_frio e ON e.id_equipo = a.id_equipo
     INNER JOIN sedes s ON s.id_sede = e.id_sede
     LEFT JOIN termohigrometro_integraciones i ON i.id_integracion = a.id_integracion
     ORDER BY a.fecha_inicio DESC`
  );
}

export async function listIntegrations() {
  const rows = await query(
    `SELECT
        i.*,
        s.nombre AS sede,
        (
          SELECT COUNT(*)
          FROM termohigrometro_mapeos m
          WHERE m.id_integracion = i.id_integracion AND m.activo = TRUE
        ) AS equipos_mapeados
     FROM termohigrometro_integraciones i
     INNER JOIN sedes s ON s.id_sede = i.id_sede
     ORDER BY i.activo DESC, s.nombre ASC, i.nombre ASC`
  );

  const mappingRows = await query(
    `SELECT
        m.*,
        e.nombre AS equipo,
        e.codigo AS equipo_codigo
     FROM termohigrometro_mapeos m
     INNER JOIN equipos_cadena_frio e ON e.id_equipo = m.id_equipo
     ORDER BY m.id_integracion ASC, e.nombre ASC`
  );

  const mapByIntegration = new Map();
  for (const row of mappingRows) {
    const list = mapByIntegration.get(row.id_integracion) ?? [];
    list.push(row);
    mapByIntegration.set(row.id_integracion, list);
  }

  return rows.map((row) => ({
    ...row,
    metadata: safeJson(row.metadata, {}),
    mappings: mapByIntegration.get(row.id_integracion) ?? []
  }));
}

export async function saveIntegration(payload, userId) {
  return withTransaction(async (connection) => {
    const baseValues = [
      payload.id_sede,
      payload.nombre,
      payload.protocolo ?? 'http_json',
      payload.endpoint_url ?? null,
      payload.auth_tipo ?? 'ninguna',
      payload.auth_header ?? null,
      payload.auth_valor ?? null,
      payload.username ?? null,
      payload.password ?? null,
      payload.polling_interval_segundos ?? 300,
      payload.timeout_ms ?? 10000,
      payload.activo ?? true,
      payload.metadata ? JSON.stringify(payload.metadata) : null
    ];

    let integrationId = Number(payload.id_integracion ?? 0);

    if (integrationId > 0) {
      await connection.execute(
        `UPDATE termohigrometro_integraciones SET
          id_sede = ?, nombre = ?, protocolo = ?, endpoint_url = ?, auth_tipo = ?, auth_header = ?,
          auth_valor = ?, username = ?, password = ?, polling_interval_segundos = ?, timeout_ms = ?,
          activo = ?, metadata = ?, fecha_modificacion = CURRENT_TIMESTAMP
         WHERE id_integracion = ?`,
        [...baseValues, integrationId]
      );

      await connection.execute(`DELETE FROM termohigrometro_mapeos WHERE id_integracion = ?`, [integrationId]);
    } else {
      const [result] = await connection.execute(
        `INSERT INTO termohigrometro_integraciones (
          id_sede, nombre, protocolo, endpoint_url, auth_tipo, auth_header,
          auth_valor, username, password, polling_interval_segundos, timeout_ms,
          activo, metadata, creado_por
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...baseValues, userId ?? null]
      );
      integrationId = result.insertId;
    }

    for (const mapping of payload.mappings ?? []) {
      await connection.execute(
        `INSERT INTO termohigrometro_mapeos (
          id_integracion, id_equipo, device_id, sensor_label, campo_temperatura,
          campo_humedad, campo_fecha, activo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          integrationId,
          mapping.id_equipo,
          mapping.device_id,
          mapping.sensor_label ?? null,
          mapping.campo_temperatura ?? 'temperature',
          mapping.campo_humedad ?? 'humidity',
          mapping.campo_fecha ?? 'timestamp',
          mapping.activo ?? true
        ]
      );
    }

    const integrations = await listIntegrations();
    return integrations.find((row) => Number(row.id_integracion) === integrationId) ?? null;
  });
}

async function logIntegration(connection, payload) {
  await connection.execute(
    `INSERT INTO termohigrometro_logs (
      id_integracion, id_equipo, device_id, metodo, payload_request, payload_response,
      exito, mensaje, estado_http
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.id_integracion,
      payload.id_equipo ?? null,
      payload.device_id ?? null,
      payload.metodo ?? 'poll',
      payload.payload_request ? JSON.stringify(payload.payload_request) : null,
      payload.payload_response ? JSON.stringify(payload.payload_response) : null,
      payload.exito ?? false,
      payload.mensaje ?? null,
      payload.estado_http ?? null
    ]
  );
}

export async function syncIntegration(idIntegracion, userId = null) {
  const rows = await query(
    `SELECT * FROM termohigrometro_integraciones WHERE id_integracion = ?`,
    [idIntegracion]
  );
  const integration = rows[0];

  if (!integration) {
    throw new HttpError(404, 'Integración no encontrada');
  }

  const mappings = await query(
    `SELECT * FROM termohigrometro_mapeos WHERE id_integracion = ? AND activo = TRUE ORDER BY id_mapeo ASC`,
    [idIntegracion]
  );

  if (!mappings.length) {
    throw new HttpError(400, 'La integración no tiene equipos mapeados');
  }

  if (integration.protocolo === 'webhook') {
    return {
      id_integracion: idIntegracion,
      protocolo: integration.protocolo,
      processed: 0,
      message: 'La integración webhook espera lecturas entrantes en /api/cold-chain/integrations/ingest'
    };
  }

  if (!integration.endpoint_url) {
    throw new HttpError(400, 'La integración requiere endpoint_url para sincronización automática');
  }

  const httpsAgent = new https.Agent({ rejectUnauthorized: !env.COLD_CHAIN_ALLOW_INSECURE_TLS });
  const auth = integration.auth_tipo === 'basic' && integration.username
    ? { username: integration.username, password: integration.password ?? '' }
    : undefined;

  let response;
  try {
    response = await axios.get(integration.endpoint_url, {
      timeout: Number(integration.timeout_ms ?? 10000),
      headers: buildIntegrationHeaders(integration),
      auth,
      httpsAgent
    });
  } catch (error) {
    await query(
      `UPDATE termohigrometro_integraciones
       SET ultima_sincronizacion = NOW(), ultima_sincronizacion_estado = 'error', ultima_sincronizacion_mensaje = ?
       WHERE id_integracion = ?`,
      [error.message, idIntegracion]
    );

    await withTransaction(async (connection) => {
      await logIntegration(connection, {
        id_integracion: idIntegracion,
        metodo: 'poll',
        exito: false,
        mensaje: error.message,
        estado_http: error.response?.status ?? null,
        payload_request: { endpoint_url: integration.endpoint_url }
      });
    });

    throw new HttpError(502, `No fue posible sincronizar la integración: ${error.message}`);
  }

  const items = parseResponseItems(response.data);
  let processed = 0;

  await withTransaction(async (connection) => {
    for (const mapping of mappings) {
      const rawReading = locatePayloadForMap(items, mapping);
      if (!rawReading) {
        await logIntegration(connection, {
          id_integracion: idIntegracion,
          id_equipo: mapping.id_equipo,
          device_id: mapping.device_id,
          metodo: 'poll',
          exito: false,
          mensaje: 'Sin lectura para el device_id configurado',
          estado_http: response.status,
          payload_response: response.data
        });
        continue;
      }

      const temperatura = extractNumeric(
        rawReading?.[mapping.campo_temperatura] ??
        rawReading?.temperature ??
        rawReading?.temperatura ??
        rawReading?.temp ??
        rawReading?.value
      );

      if (temperatura === null) {
        await logIntegration(connection, {
          id_integracion: idIntegracion,
          id_equipo: mapping.id_equipo,
          device_id: mapping.device_id,
          metodo: 'poll',
          exito: false,
          mensaje: 'Lectura sin temperatura numérica',
          estado_http: response.status,
          payload_response: rawReading
        });
        continue;
      }

      const humedad = extractNumeric(
        rawReading?.[mapping.campo_humedad] ??
        rawReading?.humidity ??
        rawReading?.humedad
      );

      await insertReading(connection, {
        id_equipo: mapping.id_equipo,
        id_integracion: idIntegracion,
        device_id_remoto: mapping.device_id,
        fecha_lectura_fuente: readingTimestamp(rawReading),
        temperatura,
        humedad,
        fuente: 'api',
        observaciones: `Lectura automática ${integration.nombre}`,
        payload_json: rawReading
      }, userId);

      await connection.execute(
        `UPDATE termohigrometro_mapeos SET ultima_lectura = NOW() WHERE id_mapeo = ?`,
        [mapping.id_mapeo]
      );

      await logIntegration(connection, {
        id_integracion: idIntegracion,
        id_equipo: mapping.id_equipo,
        device_id: mapping.device_id,
        metodo: 'poll',
        exito: true,
        mensaje: 'Lectura sincronizada',
        estado_http: response.status,
        payload_request: { endpoint_url: integration.endpoint_url },
        payload_response: rawReading
      });

      processed += 1;
    }
  });

  await query(
    `UPDATE termohigrometro_integraciones
     SET ultima_sincronizacion = NOW(),
         ultima_sincronizacion_estado = ?,
         ultima_sincronizacion_mensaje = ?
     WHERE id_integracion = ?`,
    [processed > 0 ? 'ok' : 'error', processed > 0 ? `Lecturas procesadas: ${processed}` : 'No se procesaron lecturas', idIntegracion]
  );

  return {
    id_integracion: idIntegracion,
    protocolo: integration.protocolo,
    processed,
    status_code: response.status
  };
}

export async function ingestIntegrationReadings(payload, userId = null) {
  const integrationRows = await query(
    `SELECT * FROM termohigrometro_integraciones WHERE id_integracion = ?`,
    [payload.id_integracion]
  );
  const integration = integrationRows[0];

  if (!integration) {
    throw new HttpError(404, 'Integración no encontrada');
  }

  const mappings = await query(
    `SELECT * FROM termohigrometro_mapeos WHERE id_integracion = ? AND activo = TRUE`,
    [payload.id_integracion]
  );

  if (!mappings.length) {
    throw new HttpError(400, 'La integración no tiene mapeos activos');
  }

  const readings = Array.isArray(payload.readings) ? payload.readings : [payload.readings];
  let processed = 0;

  await withTransaction(async (connection) => {
    for (const rawReading of readings) {
      const deviceId = String(rawReading?.device_id ?? rawReading?.deviceId ?? '').trim();
      const mapping = mappings.find((item) => String(item.device_id) === deviceId);

      if (!mapping) {
        continue;
      }

      const temperatura = extractNumeric(
        rawReading?.[mapping.campo_temperatura] ??
        rawReading?.temperature ??
        rawReading?.temperatura ??
        rawReading?.temp ??
        rawReading?.value
      );

      if (temperatura === null) {
        continue;
      }

      const humedad = extractNumeric(
        rawReading?.[mapping.campo_humedad] ??
        rawReading?.humidity ??
        rawReading?.humedad
      );

      await insertReading(connection, {
        id_equipo: mapping.id_equipo,
        id_integracion: payload.id_integracion,
        device_id_remoto: mapping.device_id,
        fecha_lectura_fuente: readingTimestamp(rawReading),
        temperatura,
        humedad,
        fuente: 'api',
        observaciones: `Webhook ${integration.nombre}`,
        payload_json: rawReading
      }, userId);

      await connection.execute(
        `UPDATE termohigrometro_mapeos SET ultima_lectura = NOW() WHERE id_mapeo = ?`,
        [mapping.id_mapeo]
      );

      await logIntegration(connection, {
        id_integracion: payload.id_integracion,
        id_equipo: mapping.id_equipo,
        device_id: mapping.device_id,
        metodo: 'webhook',
        exito: true,
        mensaje: 'Lectura webhook sincronizada',
        payload_response: rawReading
      });

      processed += 1;
    }
  });

  await query(
    `UPDATE termohigrometro_integraciones
     SET ultima_sincronizacion = NOW(),
         ultima_sincronizacion_estado = ?,
         ultima_sincronizacion_mensaje = ?
     WHERE id_integracion = ?`,
    [processed > 0 ? 'ok' : 'error', processed > 0 ? `Lecturas procesadas: ${processed}` : 'Webhook sin lecturas aplicables', payload.id_integracion]
  );

  return {
    id_integracion: payload.id_integracion,
    processed
  };
}

export async function listRecentAutomaticLogs(limit = 50) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 200));
  return query(
    `SELECT
        l.*,
        i.nombre AS integracion,
        e.nombre AS equipo
     FROM termohigrometro_logs l
     INNER JOIN termohigrometro_integraciones i ON i.id_integracion = l.id_integracion
     LEFT JOIN equipos_cadena_frio e ON e.id_equipo = l.id_equipo
     ORDER BY l.fecha_hora DESC
     LIMIT ${safeLimit}`
  );
}
