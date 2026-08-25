import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../../config/db.js';

// Integration-style contract test: connects to the real database configured
// via .env (the same one the app uses) and verifies the columns that
// dashboard.service.js and multisite.service.js depend on actually exist.
//
// This is the test that would have caught the incident where a runtime
// migration silently dropped productos.es_controlado, and where
// solicitudes_compra_sedes_detalle had a different column name than the
// code expected — both only surfaced as "Unknown column" 500s in the
// browser, never as a code-level type/lint error, because the queries are
// plain SQL strings.
//
// Requires DB connectivity (same as running the app itself). If the DB is
// unreachable in a given environment, this suite fails loudly rather than
// silently skipping, since a broken DB connection is itself the class of
// problem we want surfaced before it reaches the UI.

const REQUIRED_COLUMNS = {
  productos: [
    'id_producto', 'activo', 'codigo_barras', 'requiere_cadena_frio',
    'es_controlado', 'stock_minimo', 'costo_referencia', 'sku', 'nombre_comercial'
  ],
  solicitudes_compra_sedes_detalle: [
    'id_solicitud_compra_detalle', 'id_solicitud_compra_sede', 'id_producto',
    'cantidad_solicitada', 'cantidad_atendida'
  ],
  solicitudes_compra_sedes: [
    'id_solicitud_compra_sede', 'consecutivo', 'estado', 'prioridad',
    'id_sede_origen', 'id_sede_central', 'id_usuario_solicita', 'id_usuario_revision',
    'metadata', 'fecha_solicitud'
  ],
  log_auditoria: [
    'id_log', 'fecha_hora', 'id_usuario', 'id_sede', 'modulo', 'accion',
    'descripcion', 'resultado', 'request_id', 'endpoint', 'http_status', 'severidad'
  ]
};

let existingColumnsByTable = {};

beforeAll(async () => {
  const tables = Object.keys(REQUIRED_COLUMNS);
  const placeholders = tables.map(() => '?').join(',');
  const rows = await query(
    `SELECT TABLE_NAME, COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${placeholders})`,
    tables
  );
  existingColumnsByTable = rows.reduce((acc, row) => {
    const table = row.TABLE_NAME;
    (acc[table] ??= new Set()).add(row.COLUMN_NAME);
    return acc;
  }, {});
});

describe('database schema contract', () => {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    describe(table, () => {
      for (const column of columns) {
        it(`has column "${column}"`, () => {
          const existing = existingColumnsByTable[table] ?? new Set();
          expect(existing.has(column), `${table}.${column} is missing from the live schema`).toBe(true);
        });
      }
    });
  }

  it('solicitudes_compra_sedes.estado allows the "cancelada" value used by updatePurchaseRequestStatus', async () => {
    const [column] = await query(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'solicitudes_compra_sedes' AND COLUMN_NAME = 'estado'`
    );
    expect(column?.COLUMN_TYPE ?? '').toContain("'cancelada'");
  });
});
