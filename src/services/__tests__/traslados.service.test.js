import { describe, it, expect, vi, beforeEach } from 'vitest';

// createTraslado dejaba pendiente el traslado (validando stock, insertando
// en `traslados`) pero nunca dejaba trazabilidad — a diferencia de
// recibirTraslado ('RECEPCION') y rechazarTraslado ('RECHAZO') en este mismo
// archivo, que sí la registran.
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));
vi.mock('../traceability.service.js', () => ({
  recordProcessTrace: vi.fn()
}));

const { query } = await import('../../config/db.js');
const { recordProcessTrace } = await import('../traceability.service.js');
const { createTraslado, listTraslados } = await import('../traslados.service.js');

describe('traslados.service createTraslado', () => {
  beforeEach(() => {
    query.mockReset();
    recordProcessTrace.mockReset();
  });

  it('records an audit trace referencing the new traslado', async () => {
    query
      .mockResolvedValueOnce([{ cantidad_disponible: 20, id_producto: 7, nombre_comercial: 'Acetaminofén' }])
      .mockResolvedValueOnce({ insertId: 44 });

    const result = await createTraslado(
      { id_lote: 3, id_ubicacion_origen: 1, id_almacen_origen: 1, id_ubicacion_destino: 2, id_almacen_destino: 2, cantidad: 5 },
      9
    );

    expect(result).toMatchObject({ id_traslado: 44 });
    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [connectionArg, entry] = recordProcessTrace.mock.calls[0];
    expect(connectionArg).toBeNull();
    expect(entry).toMatchObject({
      proceso: 'TRASLADOS', subproceso: 'CREACION',
      id_usuario: 9, referencia_tipo: 'TRASLADO', referencia_id: 44
    });
  });

  it('rejects without tracing when there is not enough stock at the origin', async () => {
    query.mockResolvedValueOnce([{ cantidad_disponible: 2, id_producto: 7, nombre_comercial: 'Acetaminofén' }]);

    await expect(createTraslado(
      { id_lote: 3, id_ubicacion_origen: 1, id_almacen_origen: 1, id_ubicacion_destino: 2, id_almacen_destino: 2, cantidad: 5 },
      9
    )).rejects.toThrow(/Stock insuficiente/);

    expect(recordProcessTrace).not.toHaveBeenCalled();
  });
});

describe('traslados.service listTraslados', () => {
  beforeEach(() => {
    query.mockReset();
    query.mockResolvedValue([]);
  });

  it('id_almacen: matches either origen OR destino, unlike id_almacen_origen/destino (exact match) — needed for the Historial tab', async () => {
    await listTraslados({ id_almacen: 6 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/\(t\.id_almacen_origen = \? OR t\.id_almacen_destino = \?\)/);
    expect(params).toEqual([6, 6]);
  });

  it('is unfiltered (no WHERE, no params) when no filters are given', async () => {
    await listTraslados();
    const [sql, params] = query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([]);
  });

  it('combines estado with id_almacen when both are given', async () => {
    await listTraslados({ estado: 'pendiente', id_almacen: 6 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/t\.estado = \?/);
    expect(sql).toMatch(/\(t\.id_almacen_origen = \? OR t\.id_almacen_destino = \?\)/);
    expect(params).toEqual(['pendiente', 6, 6]);
  });
});
