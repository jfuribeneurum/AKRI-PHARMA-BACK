import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../config/env.js';
import { query } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPackageVersion() {
  try {
    const packagePath = path.join(__dirname, '..', '..', 'package.json');
    const raw = fs.readFileSync(packagePath, 'utf8');
    return JSON.parse(raw)?.version ?? null;
  } catch (_error) {
    return null;
  }
}

const backendVersion = readPackageVersion();

function iso(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function statusLabel(kind) {
  switch (kind) {
    case 'ok':
      return 'Operativo';
    case 'mock':
      return 'Modo mock';
    case 'configured':
      return 'Configurado';
    case 'warning':
      return 'Atención';
    case 'degraded':
      return 'Degradado';
    case 'unconfigured':
      return 'Sin configurar';
    case 'error':
      return 'Error';
    default:
      return 'Desconocido';
  }
}

function computeOverallStatus(parts) {
  if (parts.some((part) => part?.status === 'error')) {
    return 'error';
  }
  if (parts.some((part) => ['degraded', 'warning', 'unconfigured'].includes(part?.status))) {
    return 'warning';
  }
  if (parts.some((part) => ['mock', 'configured'].includes(part?.status))) {
    return 'ok';
  }
  return 'ok';
}

async function getDatabaseStatus() {
  const startedAt = Date.now();

  try {
    const rows = await query('SELECT DATABASE() AS db_name, NOW() AS server_time');
    const row = rows[0] ?? {};
    return {
      status: 'ok',
      label: statusLabel('ok'),
      database: row.db_name ?? env.DB_NAME,
      host: env.DB_HOST,
      port: env.DB_PORT,
      latency_ms: Date.now() - startedAt,
      server_time: iso(row.server_time),
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      label: statusLabel('error'),
      database: env.DB_NAME,
      host: env.DB_HOST,
      port: env.DB_PORT,
      message: error.message,
      checked_at: new Date().toISOString()
    };
  }
}

async function getSiesaStatus(databaseStatus) {
  if (databaseStatus.status !== 'ok') {
    return {
      status: 'degraded',
      label: statusLabel('degraded'),
      message: 'No fue posible evaluar SIESA porque la base de datos no está disponible.',
      checked_at: new Date().toISOString()
    };
  }

  try {
    const [configRow] = await query(
      `SELECT id_config, nombre, api_base_url, auth_url, invoice_endpoint, ambiente, timeout_ms, fecha_modificacion
       FROM integracion_siesa_config
       WHERE es_activo = TRUE
       ORDER BY id_config DESC
       LIMIT 1`
    );

    const [invoiceStats] = await query(
      `SELECT
          COUNT(*) AS total_facturas,
          SUM(CASE WHEN estado IN ('borrador', 'emitida', 'enviada_siesa') THEN 1 ELSE 0 END) AS pendientes,
          SUM(CASE WHEN estado = 'aceptada' THEN 1 ELSE 0 END) AS aceptadas,
          SUM(CASE WHEN estado = 'rechazada' THEN 1 ELSE 0 END) AS rechazadas
       FROM facturas`
    );

    const [lastLog] = await query(
      `SELECT fecha_hora, estado_http, exito, endpoint, mensaje_error
       FROM integracion_siesa_logs
       ORDER BY fecha_hora DESC
       LIMIT 1`
    );

    let status = 'unconfigured';
    let message = 'No existe una configuración activa del adaptador SIESA.';

    if (env.SIESA_MOCK_MODE) {
      status = 'mock';
      message = 'El backend está operando en modo mock para facturación SIESA.';
    } else if (configRow?.api_base_url) {
      status = lastLog?.exito ? 'ok' : (lastLog ? 'warning' : 'configured');
      message = lastLog?.exito
        ? 'Última interacción con SIESA registrada como exitosa.'
        : (lastLog ? 'La última interacción con SIESA registró observaciones o error.' : 'SIESA configurado; aún no hay transacciones enviadas.');
    } else if (configRow) {
      status = 'warning';
      message = 'Existe configuración SIESA, pero la URL base aún está vacía.';
    }

    return {
      status,
      label: statusLabel(status),
      mock_mode: env.SIESA_MOCK_MODE,
      ambiente: configRow?.ambiente ?? 'sandbox',
      nombre: configRow?.nombre ?? null,
      api_base_url: configRow?.api_base_url ?? null,
      auth_url: configRow?.auth_url ?? null,
      endpoint_factura: configRow?.invoice_endpoint ?? null,
      timeout_ms: configRow?.timeout_ms ?? env.SIESA_TIMEOUT_MS,
      total_facturas: toNumber(invoiceStats?.total_facturas),
      pendientes: toNumber(invoiceStats?.pendientes),
      aceptadas: toNumber(invoiceStats?.aceptadas),
      rechazadas: toNumber(invoiceStats?.rechazadas),
      ultima_interaccion: iso(lastLog?.fecha_hora),
      ultimo_estado_http: lastLog?.estado_http ?? null,
      ultimo_endpoint: lastLog?.endpoint ?? null,
      ultimo_error: lastLog?.mensaje_error ?? null,
      message,
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      label: statusLabel('error'),
      message: error.message,
      checked_at: new Date().toISOString()
    };
  }
}

async function getThermohygrometerStatus(databaseStatus) {
  if (databaseStatus.status !== 'ok') {
    return {
      status: 'degraded',
      label: statusLabel('degraded'),
      message: 'No fue posible evaluar termohigrómetros porque la base de datos no está disponible.',
      checked_at: new Date().toISOString()
    };
  }

  try {
    const [integrationStats] = await query(
      `SELECT
          COUNT(*) AS total_integraciones,
          SUM(CASE WHEN activo = TRUE THEN 1 ELSE 0 END) AS activas,
          SUM(CASE WHEN activo = TRUE AND ultima_sincronizacion_estado = 'ok' THEN 1 ELSE 0 END) AS activas_ok,
          SUM(CASE WHEN activo = TRUE AND ultima_sincronizacion_estado = 'error' THEN 1 ELSE 0 END) AS activas_error,
          MAX(ultima_sincronizacion) AS ultima_sincronizacion
       FROM termohigrometro_integraciones`
    );

    const [mappingStats] = await query(
      `SELECT COUNT(*) AS sensores_mapeados
       FROM termohigrometro_mapeos
       WHERE activo = TRUE`
    );

    const [equipmentStats] = await query(
      `SELECT COUNT(*) AS equipos_total
       FROM equipos_cadena_frio
       WHERE activo = TRUE`
    );

    const [lastReading] = await query(
      `SELECT fecha_hora, temperatura, humedad, fuente, fuera_rango, id_equipo
       FROM lecturas_cadena_frio
       ORDER BY fecha_hora DESC
       LIMIT 1`
    );

    const [readingStats24h] = await query(
      `SELECT COUNT(*) AS lecturas_24h
       FROM lecturas_cadena_frio
       WHERE fecha_hora >= (NOW() - INTERVAL 24 HOUR)`
    );

    const [alertStats] = await query(
      `SELECT COUNT(*) AS alertas_abiertas
       FROM alertas_cadena_frio
       WHERE estado = 'abierta'`
    );

    const [lastSuccessLog] = await query(
      `SELECT fecha_hora, mensaje, estado_http
       FROM termohigrometro_logs
       WHERE exito = TRUE
       ORDER BY fecha_hora DESC
       LIMIT 1`
    );

    const [lastErrorLog] = await query(
      `SELECT fecha_hora, mensaje, estado_http
       FROM termohigrometro_logs
       WHERE exito = FALSE
       ORDER BY fecha_hora DESC
       LIMIT 1`
    );

    const activeIntegrations = toNumber(integrationStats?.activas);
    const activeErrors = toNumber(integrationStats?.activas_error);
    const openAlerts = toNumber(alertStats?.alertas_abiertas);
    const readings24h = toNumber(readingStats24h?.lecturas_24h);

    let status = 'unconfigured';
    let message = 'No hay integraciones activas de termohigrómetros.';

    if (!env.COLD_CHAIN_AUTOPOLL_ENABLED) {
      status = 'warning';
      message = 'El autopoll de cadena de frío está desactivado por configuración.';
    } else if (activeIntegrations > 0) {
      if (activeErrors > 0) {
        status = 'warning';
        message = 'Existen integraciones activas con errores recientes.';
      } else if (openAlerts > 0) {
        status = 'warning';
        message = 'Hay alertas abiertas de cadena de frío que requieren seguimiento.';
      } else if (readings24h > 0) {
        status = 'ok';
        message = 'Las integraciones activas están reportando lecturas recientes.';
      } else {
        status = 'configured';
        message = 'Hay integraciones configuradas, pero aún no se registran lecturas recientes.';
      }
    }

    return {
      status,
      label: statusLabel(status),
      autopoll_enabled: env.COLD_CHAIN_AUTOPOLL_ENABLED,
      autopoll_interval_ms: env.COLD_CHAIN_AUTOPOLL_INTERVAL_MS,
      integraciones_totales: toNumber(integrationStats?.total_integraciones),
      integraciones_activas: activeIntegrations,
      integraciones_ok: toNumber(integrationStats?.activas_ok),
      integraciones_error: activeErrors,
      sensores_mapeados: toNumber(mappingStats?.sensores_mapeados),
      equipos_monitoreados: toNumber(equipmentStats?.equipos_total),
      lecturas_24h: readings24h,
      alertas_abiertas: openAlerts,
      ultima_sincronizacion: iso(integrationStats?.ultima_sincronizacion),
      ultima_lectura: iso(lastReading?.fecha_hora),
      ultima_temperatura: lastReading?.temperatura ?? null,
      ultima_humedad: lastReading?.humedad ?? null,
      ultima_fuente: lastReading?.fuente ?? null,
      ultima_fuera_rango: Boolean(lastReading?.fuera_rango ?? false),
      ultimo_sync_ok: iso(lastSuccessLog?.fecha_hora),
      ultimo_sync_error: iso(lastErrorLog?.fecha_hora),
      ultimo_error_http: lastErrorLog?.estado_http ?? null,
      ultimo_error_mensaje: lastErrorLog?.mensaje ?? null,
      message,
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      label: statusLabel('error'),
      message: error.message,
      checked_at: new Date().toISOString()
    };
  }
}


async function getMonitoringStatus(databaseStatus) {
  if (databaseStatus.status !== 'ok') {
    return {
      status: 'degraded',
      label: statusLabel('degraded'),
      metrics_enabled: env.METRICS_ENABLED,
      message: 'La base de datos no está disponible para correlacionar monitoreo operativo.',
      checked_at: new Date().toISOString()
    };
  }

  try {
    const [signatures] = await query(`SELECT COUNT(*) AS total_firmas, MAX(fecha_firma) AS ultima_firma FROM firmas_transacciones`);
    const [processes] = await query(`SELECT COUNT(*) AS procesos_24h FROM procesos_terminados_trazabilidad WHERE fecha_hora >= (NOW() - INTERVAL 24 HOUR)`);
    return {
      status: env.METRICS_ENABLED ? 'ok' : 'warning',
      label: statusLabel(env.METRICS_ENABLED ? 'ok' : 'warning'),
      metrics_enabled: env.METRICS_ENABLED,
      request_trace_enabled: env.REQUEST_TRACE_ENABLED,
      firmas_totales: Number(signatures?.total_firmas ?? 0),
      procesos_24h: Number(processes?.procesos_24h ?? 0),
      ultima_firma: iso(signatures?.ultima_firma),
      message: env.METRICS_ENABLED ? 'Monitoreo y trazabilidad productiva habilitados.' : 'Las métricas están desactivadas en la configuración actual.',
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      label: statusLabel('error'),
      metrics_enabled: env.METRICS_ENABLED,
      message: error.message,
      checked_at: new Date().toISOString()
    };
  }
}

async function getBackupStatus(databaseStatus) {
  if (databaseStatus.status !== 'ok') {
    return {
      status: 'degraded',
      label: statusLabel('degraded'),
      message: 'No fue posible evaluar el estado de backups porque la base de datos no está disponible.',
      checked_at: new Date().toISOString()
    };
  }

  try {
    const [lastBackup] = await query(
      `SELECT tipo, archivo_principal, estado, fecha_inicio, fecha_fin, tamano_bytes, checksum_sha256
       FROM backups_ejecuciones
       ORDER BY fecha_inicio DESC
       LIMIT 1`
    );

    if (!lastBackup) {
      return {
        status: 'warning',
        label: statusLabel('warning'),
        message: 'No existen backups registrados todavía.',
        checked_at: new Date().toISOString()
      };
    }

    const backupStatus = lastBackup.estado === 'ok' ? 'ok' : (lastBackup.estado === 'running' ? 'configured' : 'warning');
    return {
      status: backupStatus,
      label: statusLabel(backupStatus),
      ultimo_tipo: lastBackup.tipo,
      ultimo_archivo: lastBackup.archivo_principal,
      ultimo_estado: lastBackup.estado,
      ultima_ejecucion: iso(lastBackup.fecha_inicio),
      fecha_fin: iso(lastBackup.fecha_fin),
      tamano_bytes: Number(lastBackup.tamano_bytes ?? 0),
      checksum_sha256: lastBackup.checksum_sha256 ?? null,
      message: lastBackup.estado === 'ok' ? 'El último backup finalizó correctamente.' : 'El último backup requiere revisión.',
      checked_at: new Date().toISOString()
    };
  } catch (error) {
    return {
      status: 'error',
      label: statusLabel('error'),
      message: error.message,
      checked_at: new Date().toISOString()
    };
  }
}

export async function getConnectivityOverview() {
  const checkedAt = new Date().toISOString();
  const backend = {
    status: 'ok',
    label: statusLabel('ok'),
    name: 'AkriPharmacy API',
    version: backendVersion,
    environment: env.NODE_ENV,
    node_version: process.version,
    uptime_seconds: Math.round(process.uptime()),
    checked_at: checkedAt,
    message: 'El backend está operativo y respondió a la solicitud de diagnóstico.'
  };

  const frontendBackend = {
    status: 'ok',
    label: statusLabel('ok'),
    route: '/api/status/overview',
    checked_at: checkedAt,
    message: 'El frontend autenticado alcanzó el backend y obtuvo respuesta consolidada.'
  };

  const database = await getDatabaseStatus();
  const siesa = await getSiesaStatus(database);
  const thermohygrometers = await getThermohygrometerStatus(database);
  const monitoring = await getMonitoringStatus(database);
  const backups = await getBackupStatus(database);
  const overall_status = computeOverallStatus([backend, database, siesa, thermohygrometers, monitoring, backups]);

  return {
    overall_status,
    overall_label: statusLabel(overall_status),
    checked_at: checkedAt,
    frontend_backend: frontendBackend,
    backend,
    database,
    siesa,
    thermohygrometers,
    monitoring,
    backups
  };
}
