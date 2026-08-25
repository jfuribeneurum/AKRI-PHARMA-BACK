import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Static source-level guard against re-introducing two schema-drift bugs that
// broke /dashboard/summary and /multisite/context in production use:
//
// 1. A runtime migration used to unconditionally DROP productos.es_controlado
//    on every server boot, even though ~15 call sites across the codebase
//    (dashboard, inventory, dispensing, sale, reports services) still read it.
// 2. solicitudes_compra_sedes_detalle existed in the DB with a different PK
//    name (id_solicitud_compra_sede_detalle) and without cantidad_atendida,
//    while every query in the codebase expected id_solicitud_compra_detalle.
// 3. solicitudes_compra_sedes existed with id_usuario_revisa instead of the
//    id_usuario_revision every query expects, without a metadata column, and
//    with an estado ENUM missing the 'cancelada' value that
//    updatePurchaseRequestStatus can set — this broke both listing and
//    reviewing inter-site purchase requests (/multisite/purchase-requests).
//
// ensureRuntimeSchema() is a single 800+ line imperative function against a
// live pool, which makes true isolated unit tests impractical without a much
// bigger refactor. This guard test instead asserts the fixed source text
// directly, so a future edit that reintroduces the destructive DROP (or
// removes the repair steps) fails fast in CI instead of at runtime.
const schemaFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../runtime-schema.service.js'
);
const source = readFileSync(schemaFile, 'utf8');

describe('runtime-schema.service source guards', () => {
  it('never drops productos.es_controlado', () => {
    expect(source).not.toMatch(/DROP COLUMN\s+es_controlado/i);
  });

  it('ensures productos.es_controlado exists instead of dropping it', () => {
    expect(source).toMatch(
      /columnExists\('productos',\s*'es_controlado'\)[\s\S]{0,80}ADD COLUMN es_controlado/
    );
  });

  it('repairs a legacy id_solicitud_compra_sede_detalle column name', () => {
    expect(source).toMatch(/CHANGE COLUMN id_solicitud_compra_sede_detalle id_solicitud_compra_detalle/);
  });

  it('ensures solicitudes_compra_sedes_detalle.cantidad_atendida exists', () => {
    expect(source).toMatch(
      /columnExists\('solicitudes_compra_sedes_detalle',\s*'cantidad_atendida'\)[\s\S]{0,120}ADD COLUMN cantidad_atendida/
    );
  });

  it('repairs a legacy id_usuario_revisa column name on solicitudes_compra_sedes', () => {
    expect(source).toMatch(/CHANGE COLUMN id_usuario_revisa id_usuario_revision/);
  });

  it('ensures solicitudes_compra_sedes.metadata exists', () => {
    expect(source).toMatch(
      /columnExists\('solicitudes_compra_sedes',\s*'metadata'\)[\s\S]{0,120}ADD COLUMN metadata JSON/
    );
  });

  it('ensures solicitudes_compra_sedes.estado allows the "cancelada" value', () => {
    expect(source).toMatch(/ENUM\('pendiente','revisada','aprobada','rechazada','atendida','cancelada'\)/);
  });

  it('ensures movimientos_inventario.tipo includes the 5 friendly movement codes the API already accepts', () => {
    for (const value of [
      'inventario_faltante_fisico', 'disposicion_final', 'movimiento_interno',
      'inventario_sobrante_fisico', 'bonificacion'
    ]) {
      expect(source).toContain(`'${value}'`);
    }
    expect(source).toMatch(/MODIFY COLUMN tipo ENUM\(/);
  });

  it('ensures ingresos.id_almacen exists, so ingreso stock movements can resolve the active almacén instead of guessing it from free text', () => {
    expect(source).toMatch(
      /columnExists\('ingresos',\s*'id_almacen'\)[\s\S]{0,80}ADD COLUMN id_almacen/
    );
  });

  it('ensures dispensacion_hs_control.contrato and .regimen exist', () => {
    expect(source).toMatch(
      /columnExists\('dispensacion_hs_control',\s*'contrato'\)[\s\S]{0,80}ADD COLUMN contrato/
    );
    expect(source).toMatch(
      /columnExists\('dispensacion_hs_control',\s*'regimen'\)[\s\S]{0,80}ADD COLUMN regimen/
    );
  });

  it('seeds the HealthSphere-only formas farmacéuticas so "Forma farmacéutica" can auto-fill for them', () => {
    expect(source).toMatch(/FORMAS_FARMACEUTICAS_HS_SEED/);
    expect(source).toMatch(/INSERT IGNORE INTO formas_farmaceuticas/);
    // 39 forma types exist in HealthSphere with no local match at the time this was written.
    const seedMatch = source.match(/FORMAS_FARMACEUTICAS_HS_SEED = \[([\s\S]*?)\n\];/);
    expect(seedMatch).toBeTruthy();
    const rowCount = (seedMatch[1].match(/^\s*\[/gm) ?? []).length;
    expect(rowCount).toBe(39);
  });
});
