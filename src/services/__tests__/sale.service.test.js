import { describe, it, expect, vi, beforeEach } from 'vitest';

// createSale() descuenta inventario real (existencias, movimientos_inventario
// y, si aplica, controlados_libro) igual que Dispensación y Dispensación HS —
// pero a diferencia de esos dos módulos, nunca dejaba rastro en
// procesos_terminados_trazabilidad. Estos tests fijan ese hueco.
const { mockConnection } = vi.hoisted(() => ({ mockConnection: { execute: vi.fn() } }));

vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (work) => work(mockConnection)),
  env: {}
}));
vi.mock('../../config/env.js', () => ({ env: { ALLOW_STOCK_NEGATIVE: false } }));
vi.mock('../traceability.service.js', () => ({
  recordProcessTrace: vi.fn()
}));

const { withTransaction } = await import('../../config/db.js');
const { recordProcessTrace } = await import('../traceability.service.js');
const { createSale } = await import('../sale.service.js');

function routeExecute(overrides) {
  mockConnection.execute.mockImplementation(async (sql) => {
    for (const [pattern, handler] of overrides) {
      if (pattern.test(sql)) return handler(sql);
    }
    if (/^INSERT/.test(sql)) return [{ insertId: 1 }];
    if (/^UPDATE/.test(sql)) return [{ affectedRows: 1 }];
    return [[]];
  });
}

function mockLoteRow(overrides = {}) {
  return {
    id_lote: 3,
    numero_lote: 'L-1',
    mx_control: 0,
    es_controlado: 0,
    nombre_comercial: 'Acetaminofén',
    id_producto: 7,
    id_existencia: 500,
    id_almacen: 1,
    id_ubicacion: 1,
    cantidad_disponible: 10,
    costo_unitario: 50,
    ...overrides
  };
}

function basePayload(overrides = {}) {
  return {
    id_sede: 4,
    folio_venta: 'F-001',
    items: [{ id_lote: 3, cantidad: 2, precio_unitario: 100 }],
    ...overrides
  };
}

describe('sale.service createSale — id_sede y trazabilidad', () => {
  beforeEach(() => {
    withTransaction.mockClear();
    mockConnection.execute.mockReset();
    recordProcessTrace.mockReset();
  });

  it('saves id_sede on the ventas row — la tabla lo exige NOT NULL', async () => {
    routeExecute([
      [/INSERT INTO ventas \(/, () => [{ insertId: 55 }]],
      [/FROM lotes l/, () => [[mockLoteRow()]]]
    ]);

    await createSale(basePayload({ id_sede: 4 }), 9);

    const ventaInsertCall = mockConnection.execute.mock.calls.find(([sql]) => /INSERT INTO ventas \(/.test(sql));
    expect(ventaInsertCall[0]).toMatch(/id_sede/);
    expect(ventaInsertCall[1][0]).toBe(4);
  });

  it('records process traceability with the requesting user, sede and sale id', async () => {
    routeExecute([
      [/INSERT INTO ventas \(/, () => [{ insertId: 55 }]],
      [/FROM lotes l/, () => [[mockLoteRow()]]]
    ]);

    const result = await createSale(basePayload({ id_sede: 4 }), 9);

    expect(result).toMatchObject({ id_venta: 55 });
    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    expect(recordProcessTrace).toHaveBeenCalledWith(mockConnection, expect.objectContaining({
      proceso: 'VENTA',
      subproceso: 'CREAR_VENTA',
      id_usuario: 9,
      id_sede: 4,
      referencia_tipo: 'VENTA',
      referencia_id: 55
    }));
  });

  it('runs the trace write inside the same transaction as the rest of the sale', async () => {
    routeExecute([
      [/INSERT INTO ventas \(/, () => [{ insertId: 57 }]],
      [/FROM lotes l/, () => [[mockLoteRow()]]]
    ]);

    await createSale(basePayload({ id_sede: 4 }), 9);

    const traceCall = recordProcessTrace.mock.calls[0];
    expect(traceCall[0]).toBe(mockConnection);
  });
});
