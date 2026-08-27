import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// POST/PUT/DELETE /ingresos mutan ingresos, ingresos_items y (vía
// actualizarInventario) existencias/movimientos_inventario, pero no dejaban
// ningún rastro en procesos_terminados_trazabilidad — a diferencia de
// prácticamente todo el resto de módulos que tocan inventario real
// (ventas, dispensación, órdenes de compra, traslados).
const routeFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../ingresos.routes.js'
);
const source = readFileSync(routeFile, 'utf8');

describe('ingresos.routes source guards', () => {
  it('imports recordProcessTrace', () => {
    expect(source).toMatch(/import\s*\{\s*recordProcessTrace\s*\}\s*from\s*['"]\.\.\/services\/traceability\.service\.js['"]/);
  });

  it('traces the creation of a new ingreso', () => {
    const postHandler = source.slice(source.indexOf("router.post('/'"), source.indexOf("router.get('/:id'"));
    expect(postHandler).toMatch(/recordProcessTrace\(connection,/);
    expect(postHandler).toMatch(/referencia_tipo:\s*'INGRESO'/);
  });

  it('traces edits to an existing ingreso', () => {
    const putHandler = source.slice(source.indexOf("router.put('/:id'"), source.indexOf("router.delete('/:id'"));
    expect(putHandler).toMatch(/recordProcessTrace\(connection,/);
  });

  it('traces deletion of an ingreso', () => {
    const deleteHandler = source.slice(source.indexOf("router.delete('/:id'"));
    expect(deleteHandler).toMatch(/recordProcessTrace\(connection,/);
  });
});
