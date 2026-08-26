import { describe, it, expect, vi, beforeEach } from 'vitest';

// dispensarMedicamento() persists contrato/regimen, must record process
// traceability using the real requesting user (req.user.sub), and — since
// this session added real lot-based inventory deduction — must run entirely
// inside one DB transaction: descontar existencias, insertar
// movimientos_inventario y (si aplica) controlados_libro, y solo si todo
// eso sale bien, dejar el registro de control actualizado.
const { mockConnection } = vi.hoisted(() => ({ mockConnection: { execute: vi.fn() } }));

vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (work) => work(mockConnection))
}));
vi.mock('../formulacion-hs.service.js', () => ({
  getFormulacionHSById: vi.fn()
}));
vi.mock('../traceability.service.js', () => ({
  recordProcessTrace: vi.fn()
}));

const { query, withTransaction } = await import('../../config/db.js');
const { getFormulacionHSById } = await import('../formulacion-hs.service.js');
const { recordProcessTrace } = await import('../traceability.service.js');
const { dispensarMedicamento, getControlStatusBatch, getHistorialEntregas } = await import('../dispensacion-hs.service.js');

function mockFormulacion() {
  return {
    idPaciente: 1,
    nombre_paciente: 'Paciente Test',
    documento_paciente: '123456789',
    fechaFormulacion: '2026-01-01',
    medicamentos: [
      { id_med_formulacion: 10, nombre_medicamento: 'Med X', presentacion: 'Tableta', cantidad: 5 }
    ]
  };
}

// Router genérico para connection.execute: recibe un mapa de {patrón: () => filas}
// y el resto de SELECT/UPDATE/INSERT que no importan al test devuelven [] / {insertId}.
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

describe('dispensacion-hs.service dispensarMedicamento', () => {
  beforeEach(() => {
    query.mockReset();
    withTransaction.mockClear();
    mockConnection.execute.mockReset();
    recordProcessTrace.mockReset();
    getFormulacionHSById.mockReset();
  });

  it('persists contrato/regimen on insert, deducts the chosen lot and records traceability with the requesting user and sede', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[]]],
      [/INSERT INTO dispensacion_hs_control/, () => [{ insertId: 99 }]],
      [/FROM existencias e/, () => [[{ id_existencia: 500, cantidad_disponible: 10, id_almacen: 1, id_producto: 7, costo_unitario: 100, es_controlado: 0 }]]],
      [/SELECT \* FROM dispensacion_hs_control WHERE id = \?/, () => [[{ id: 99, contrato: 'contrato_1', regimen: 'contributivo' }]]]
    ]);

    const result = await dispensarMedicamento(
      {
        id_formulacion_hs: 1,
        id_med_formulacion_hs: 10,
        cantidad_dispensada: 5,
        lotes: [{ id_lote: 3, id_ubicacion: 1, cantidad: 5 }],
        contrato: 'contrato_1',
        regimen: 'contributivo',
        cantidad_pendiente_antes: 5,
        cantidad_faltante: 0
      },
      7,
      3
    );

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: 99 });

    const insertControlCall = mockConnection.execute.mock.calls.find(([sql]) => /INSERT INTO dispensacion_hs_control/.test(sql));
    expect(insertControlCall[0]).toMatch(/contrato, regimen/);
    expect(insertControlCall[1]).toEqual(expect.arrayContaining(['contrato_1', 'contributivo']));

    const deductCall = mockConnection.execute.mock.calls.find(([sql]) => /UPDATE existencias/.test(sql));
    expect(deductCall[1]).toEqual([5, 500]);

    const movementCall = mockConnection.execute.mock.calls.find(([sql]) => /INSERT INTO movimientos_inventario/.test(sql));
    expect(movementCall[0]).toMatch(/'salida_venta'/);
    expect(movementCall[1]).toEqual(expect.arrayContaining([7, 3, 1, 5, 100, 99]));

    const backfillCall = mockConnection.execute.mock.calls.find(([sql]) => /UPDATE dispensacion_hs_control SET id_producto/.test(sql));
    expect(backfillCall[1]).toEqual([7, 99]);

    // Ningún producto controlado en este caso.
    expect(mockConnection.execute.mock.calls.some(([sql]) => /INSERT INTO controlados_libro/.test(sql))).toBe(false);

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [connectionArg, entry] = recordProcessTrace.mock.calls[0];
    expect(connectionArg).toBe(mockConnection);
    expect(entry.id_sede).toBe(3);
    expect(entry.id_usuario).toBe(7);
    expect(entry.payload_json).toMatchObject({
      contrato: 'contrato_1',
      regimen: 'contributivo',
      cantidad_pendiente_antes: 5,
      cantidad_faltante: 0
    });
  });

  it('logs to controlados_libro when the resolved product is es_controlado', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[]]],
      [/INSERT INTO dispensacion_hs_control/, () => [{ insertId: 99 }]],
      [/FROM existencias e/, () => [[{ id_existencia: 500, cantidad_disponible: 10, id_almacen: 1, id_producto: 7, costo_unitario: 100, es_controlado: 1 }]]],
      [/SELECT \* FROM dispensacion_hs_control WHERE id = \?/, () => [[{ id: 99 }]]]
    ]);

    await dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 5, lotes: [{ id_lote: 3, id_ubicacion: 1, cantidad: 5 }] },
      7, 3
    );

    const libroCall = mockConnection.execute.mock.calls.find(([sql]) => /INSERT INTO controlados_libro/.test(sql));
    expect(libroCall).toBeTruthy();
    expect(libroCall[0]).toMatch(/'salida'/);
    // id_producto, id_lote, cantidad, saldo_anterior, saldo_nuevo, referencia_id, usuario_responsable
    expect(libroCall[1]).toEqual([7, 3, 5, 10, 5, 99, 7]);
  });

  it('rejects with no stock movement when cantidad_dispensada > 0 but no lotes were chosen', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[]]]
    ]);

    await expect(dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 5 },
      7, 3
    )).rejects.toThrow(/elegir de qué lote/);

    expect(mockConnection.execute.mock.calls.some(([sql]) => /INSERT INTO movimientos_inventario/.test(sql))).toBe(false);
  });

  it('rejects when the chosen lotes do not sum to the delivered quantity', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[]]]
    ]);

    await expect(dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 5, lotes: [{ id_lote: 3, id_ubicacion: 1, cantidad: 3 }] },
      7, 3
    )).rejects.toThrow(/no coincide con la cantidad a entregar/);
  });

  it('rejects when a chosen lot does not have enough stock', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[]]],
      [/FROM existencias e/, () => [[{ id_existencia: 500, cantidad_disponible: 2, id_almacen: 1, id_producto: 7, costo_unitario: 100, es_controlado: 0 }]]]
    ]);

    await expect(dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 5, lotes: [{ id_lote: 3, id_ubicacion: 1, cantidad: 5 }] },
      7, 3
    )).rejects.toThrow(/Stock insuficiente/);

    expect(mockConnection.execute.mock.calls.some(([sql]) => /UPDATE existencias/.test(sql))).toBe(false);
  });

  it('does not require lotes nor touch inventory when cantidad_dispensada is 0 (pure override correction)', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[{ id: 55 }]]],
      [/SELECT cantidad_formulada, cantidad_dispensada FROM/, () => [[{ cantidad_formulada: 5, cantidad_dispensada: 2 }]]],
      [/SELECT \* FROM dispensacion_hs_control WHERE id = \?/, () => [[{ id: 55 }]]]
    ]);

    await dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 0, cantidad_dispensada_total_override: 4 },
      9, 5
    );

    expect(mockConnection.execute.mock.calls.some(([sql]) => /FROM existencias e/.test(sql))).toBe(false);
    expect(mockConnection.execute.mock.calls.some(([sql]) => /INSERT INTO movimientos_inventario/.test(sql))).toBe(false);

    const updateCall = mockConnection.execute.mock.calls.find(([sql]) => sql.startsWith('UPDATE dispensacion_hs_control\n') || /^UPDATE dispensacion_hs_control/.test(sql));
    expect(updateCall[1][0]).toBe(4);
  });

  it('overwrites contrato/regimen (not appended) when the medication was already partially dispensed', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[{ id: 55 }]]],
      [/SELECT cantidad_formulada, cantidad_dispensada FROM/, () => [[{ cantidad_formulada: 5, cantidad_dispensada: 2 }]]],
      [/FROM existencias e/, () => [[{ id_existencia: 500, cantidad_disponible: 10, id_almacen: 1, id_producto: 7, costo_unitario: 100, es_controlado: 0 }]]],
      [/SELECT \* FROM dispensacion_hs_control WHERE id = \?/, () => [[{ id: 55, contrato: 'contrato_2', regimen: 'subsidiado' }]]]
    ]);

    await dispensarMedicamento(
      {
        id_formulacion_hs: 1,
        id_med_formulacion_hs: 10,
        cantidad_dispensada: 3,
        lotes: [{ id_lote: 3, id_ubicacion: 1, cantidad: 3 }],
        contrato: 'contrato_2',
        regimen: 'subsidiado',
        cantidad_pendiente_antes: 3,
        cantidad_faltante: 1
      },
      8,
      4
    );

    const updateCall = mockConnection.execute.mock.calls.find(([sql]) => /UPDATE dispensacion_hs_control\s+SET cantidad_dispensada/.test(sql));
    expect(updateCall[0]).toMatch(/contrato = \?/);
    expect(updateCall[0]).toMatch(/regimen = \?/);
    expect(updateCall[1]).toEqual(expect.arrayContaining(['contrato_2', 'subsidiado']));

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry.id_sede).toBe(4);
    expect(entry.id_usuario).toBe(8);
    expect(entry.payload_json).toMatchObject({
      contrato: 'contrato_2',
      regimen: 'subsidiado',
      cantidad_pendiente_antes: 3,
      cantidad_faltante: 1
    });
  });

  it('lets cantidad_dispensada_total_override replace the accumulated total instead of adding the delta', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[{ id: 55 }]]],
      [/SELECT cantidad_formulada, cantidad_dispensada FROM/, () => [[{ cantidad_formulada: 5, cantidad_dispensada: 2 }]]],
      [/FROM existencias e/, () => [[{ id_existencia: 500, cantidad_disponible: 10, id_almacen: 1, id_producto: 7, costo_unitario: 100, es_controlado: 0 }]]],
      [/SELECT \* FROM dispensacion_hs_control WHERE id = \?/, () => [[{ id: 55 }]]]
    ]);

    await dispensarMedicamento(
      {
        id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 1,
        lotes: [{ id_lote: 3, id_ubicacion: 1, cantidad: 1 }],
        cantidad_dispensada_total_override: 4
      },
      9,
      5
    );

    const updateCall = mockConnection.execute.mock.calls.find(([sql]) => /UPDATE dispensacion_hs_control\s+SET cantidad_dispensada/.test(sql));
    // 2 (ya dispensado) + 1 (delta) sería 3 sin override; con override debe quedar en 4, no en 3.
    expect(updateCall[1][0]).toBe(4);

    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry.payload_json.cantidad_dispensada_total_override).toBe(4);
  });

  it('rejects a cantidad_dispensada_total_override greater than what was formulated', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    routeExecute([
      [/SELECT id FROM dispensacion_hs_control/, () => [[{ id: 55 }]]],
      [/SELECT cantidad_formulada, cantidad_dispensada FROM/, () => [[{ cantidad_formulada: 5, cantidad_dispensada: 2 }]]]
    ]);

    await expect(dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 0, cantidad_dispensada_total_override: 99 },
      9,
      5
    )).rejects.toThrow(/mayor a lo formulado/);
  });
});

// The formulaciones list shows the last dispensing date/time under "Ver
// detalle" once a formulación is no longer pendiente, so the list-level
// aggregate must expose that timestamp per formulación.
describe('dispensacion-hs.service getControlStatusBatch', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('aggregates the last dispensing timestamp per formulación', async () => {
    query.mockResolvedValue([]);
    await getControlStatusBatch([1, 2]);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/MAX\(fecha_dispensacion\)\s+AS\s+ultima_fecha_dispensacion/);
  });
});

// El "Histórico de entregas" del modal muestra cada entrega real ya hecha
// (una fila por lote usado en movimientos_inventario), no solo el acumulado
// que guarda dispensacion_hs_control.
describe('dispensacion-hs.service getHistorialEntregas', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('returns an empty list without querying movimientos when the formulación has no control rows', async () => {
    query.mockResolvedValueOnce([]);
    const result = await getHistorialEntregas(999);
    expect(result).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('joins each movimiento back to the medicamento name of its control row', async () => {
    query
      .mockResolvedValueOnce([
        { id: 15, id_med_formulacion_hs: 548, nombre_medicamento: 'ABACAVIR 300 MG TABLETA RECUBIERTA' }
      ])
      .mockResolvedValueOnce([
        { id_movimiento: 324, referencia_id: 15, fecha_hora: '2026-08-26T21:31:19.000Z', cantidad: 2, numero_lote: 'LOTE-TEST-ABC-01', almacen: 'Almacén Principal', usuario: 'Akri Admin Sistema' }
      ]);
    const result = await getHistorialEntregas(517);
    expect(result).toEqual([{
      id_movimiento: 324, referencia_id: 15, fecha_hora: '2026-08-26T21:31:19.000Z', cantidad: 2,
      numero_lote: 'LOTE-TEST-ABC-01', almacen: 'Almacén Principal', usuario: 'Akri Admin Sistema',
      nombre_medicamento: 'ABACAVIR 300 MG TABLETA RECUBIERTA'
    }]);
    const [movimientosSql, movimientosParams] = query.mock.calls[1];
    expect(movimientosSql).toMatch(/referencia_tipo = 'DISPENSACION_HS_CONTROL'/);
    expect(movimientosParams).toEqual([15]);
  });
});
