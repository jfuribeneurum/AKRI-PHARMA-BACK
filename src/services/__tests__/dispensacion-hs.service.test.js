import { describe, it, expect, vi, beforeEach } from 'vitest';

// dispensarMedicamento() persists contrato/regimen (new fields) and must record
// process traceability for every dispensing action, using the real requesting
// user (req.user.sub) — a route bug (req.user.id_usuario, which never exists on
// the JWT payload) silently stored id_usuario = NULL on every HS dispensing
// record, losing who-dispensed-what traceability entirely.
vi.mock('../../config/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));
vi.mock('../formulacion-hs.service.js', () => ({
  getFormulacionHSById: vi.fn()
}));
vi.mock('../traceability.service.js', () => ({
  recordProcessTrace: vi.fn()
}));

const { query } = await import('../../config/db.js');
const { getFormulacionHSById } = await import('../formulacion-hs.service.js');
const { recordProcessTrace } = await import('../traceability.service.js');
const { dispensarMedicamento, getControlStatusBatch } = await import('../dispensacion-hs.service.js');

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

describe('dispensacion-hs.service dispensarMedicamento', () => {
  beforeEach(() => {
    query.mockReset();
    recordProcessTrace.mockReset();
    getFormulacionHSById.mockReset();
  });

  it('persists contrato/regimen on insert and records traceability with the requesting user and sede', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM dispensacion_hs_control')) return [];
      if (sql.includes('INSERT INTO dispensacion_hs_control')) return { insertId: 99 };
      if (sql.includes('SELECT * FROM dispensacion_hs_control WHERE id = ?')) {
        return [{ id: 99, contrato: 'contrato_1', regimen: 'contributivo' }];
      }
      throw new Error(`Unmocked SQL in test: ${sql}`);
    });

    const result = await dispensarMedicamento(
      {
        id_formulacion_hs: 1,
        id_med_formulacion_hs: 10,
        cantidad_dispensada: 5,
        contrato: 'contrato_1',
        regimen: 'contributivo',
        cantidad_pendiente_antes: 5,
        cantidad_faltante: 0
      },
      7,
      3
    );

    expect(result).toMatchObject({ id: 99 });

    const insertCall = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO dispensacion_hs_control'));
    expect(insertCall[0]).toMatch(/contrato, regimen/);
    expect(insertCall[1]).toEqual(expect.arrayContaining(['contrato_1', 'contributivo']));

    expect(recordProcessTrace).toHaveBeenCalledTimes(1);
    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry.id_sede).toBe(3);
    expect(entry.id_usuario).toBe(7);
    expect(entry.payload_json).toMatchObject({
      contrato: 'contrato_1',
      regimen: 'contributivo',
      cantidad_pendiente_antes: 5,
      cantidad_faltante: 0
    });
  });

  it('overwrites contrato/regimen (not appended) and records traceability when the medication was already partially dispensed', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM dispensacion_hs_control')) return [{ id: 55 }];
      if (sql.includes('SELECT cantidad_formulada, cantidad_dispensada')) {
        return [{ cantidad_formulada: 5, cantidad_dispensada: 2 }];
      }
      if (sql.startsWith('UPDATE dispensacion_hs_control')) return { affectedRows: 1 };
      if (sql.includes('SELECT * FROM dispensacion_hs_control WHERE id = ?')) {
        return [{ id: 55, contrato: 'contrato_2', regimen: 'subsidiado' }];
      }
      throw new Error(`Unmocked SQL in test: ${sql}`);
    });

    await dispensarMedicamento(
      {
        id_formulacion_hs: 1,
        id_med_formulacion_hs: 10,
        cantidad_dispensada: 3,
        contrato: 'contrato_2',
        regimen: 'subsidiado',
        cantidad_pendiente_antes: 3,
        cantidad_faltante: 1
      },
      8,
      4
    );

    const updateCall = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE dispensacion_hs_control'));
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
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM dispensacion_hs_control')) return [{ id: 55 }];
      if (sql.includes('SELECT cantidad_formulada, cantidad_dispensada')) {
        return [{ cantidad_formulada: 5, cantidad_dispensada: 2 }];
      }
      if (sql.startsWith('UPDATE dispensacion_hs_control')) return { affectedRows: 1 };
      if (sql.includes('SELECT * FROM dispensacion_hs_control WHERE id = ?')) {
        return [{ id: 55 }];
      }
      throw new Error(`Unmocked SQL in test: ${sql}`);
    });

    await dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 1, cantidad_dispensada_total_override: 4 },
      9,
      5
    );

    const updateCall = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE dispensacion_hs_control'));
    // 2 (ya dispensado) + 1 (delta) sería 3 sin override; con override debe quedar en 4, no en 3.
    expect(updateCall[1][0]).toBe(4);

    const [, entry] = recordProcessTrace.mock.calls[0];
    expect(entry.payload_json.cantidad_dispensada_total_override).toBe(4);
  });

  it('rejects a cantidad_dispensada_total_override greater than what was formulated', async () => {
    getFormulacionHSById.mockResolvedValue(mockFormulacion());
    query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM dispensacion_hs_control')) return [{ id: 55 }];
      if (sql.includes('SELECT cantidad_formulada, cantidad_dispensada')) {
        return [{ cantidad_formulada: 5, cantidad_dispensada: 2 }];
      }
      throw new Error(`Unmocked SQL in test: ${sql}`);
    });

    await expect(dispensarMedicamento(
      { id_formulacion_hs: 1, id_med_formulacion_hs: 10, cantidad_dispensada: 1, cantidad_dispensada_total_override: 99 },
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
