import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Adds an active-almacén layer on top of the existing sede session model:
// a user is scoped to one sede (usuarios_sedes), and can now switch between
// that sede's own almacenes (e.g. Medellín's two warehouses) without a new
// per-almacén permission table.
vi.mock('../../config/db.js', () => ({
  query: vi.fn()
}));

const { query } = await import('../../config/db.js');
const { selectAlmacenSession } = await import('../auth.service.js');

const BASE_USER = { id_usuario: 1, es_activo: 1, id_sede: 5, id_almacen_principal: 10, id_rol: 1 };
const ALMACENES_MEDELLIN = [
  { id_almacen: 10, codigo: 'MDE-1', nombre: 'Bodega Medellín 1', tipo: 'general', es_principal: 1 },
  { id_almacen: 11, codigo: 'MDE-2', nombre: 'Bodega Medellín 2', tipo: 'general', es_principal: 0 }
];
const USER_ACCESS = [
  { id_sede: 5, es_predeterminada: 1, puede_admin_sede: 1, codigo: 'MDE', nombre: 'Medellín', es_principal: 0, activo: 1 }
];

// Routes every query() call by matching distinctive SQL substrings, instead
// of relying on the exact call order/count of the buildAuthResponse chain
// (getUserAccess -> syncUserCurrentSite -> getSiteSummary x2 -> getSedeAlmacenes
// -> getRoleUsabilities) — that chain is an implementation detail we don't
// want this test coupled to.
function mockQueryRouter({ activeAlmacenId = 11 } = {}) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM usuarios u') && sql.includes('WHERE u.id_usuario = ?')) return [BASE_USER];
    if (sql.includes('FROM almacenes') && sql.includes('WHERE id_sede = ?')) return ALMACENES_MEDELLIN;
    if (sql.includes('UPDATE usuarios SET id_almacen_principal')) return {};
    if (sql.includes('FROM usuarios_sedes')) return USER_ACCESS;
    if (sql.includes('UPDATE usuarios') && sql.includes('id_sede = ?')) return {};
    if (sql.includes('FROM sedes s') && sql.includes('LEFT JOIN almacenes a')) {
      return [{
        sede_nombre: 'Medellín', sede_codigo: 'MDE', es_principal: 0,
        id_almacen_principal: activeAlmacenId, almacen_nombre: 'Bodega Medellín 2'
      }];
    }
    if (sql.includes('FROM role_usabilities')) return [];
    throw new Error(`Unmocked query in test: ${sql.slice(0, 80)}`);
  });
}

describe('auth.service selectAlmacenSession', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("rejects an id_almacen that does not belong to the user's active sede", async () => {
    mockQueryRouter();
    await expect(selectAlmacenSession({ userId: 1, id_almacen: 999 }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('persists the new id_almacen_principal and re-issues the session on success', async () => {
    mockQueryRouter({ activeAlmacenId: 11 });

    const result = await selectAlmacenSession({ userId: 1, id_almacen: 11 });

    const updateCall = query.mock.calls.find(([sql]) => sql.includes('UPDATE usuarios SET id_almacen_principal'));
    expect(updateCall[1]).toEqual([11, 1]);

    expect(result.user.almacenes).toEqual(ALMACENES_MEDELLIN);
    expect(result.user.almacen_selection_required).toBe(true);
    expect(result.token).toBeTruthy();

    const decoded = jwt.decode(result.token);
    expect(decoded.id_almacen).toBe(11);
  });

  it('throws 400 when no id_almacen is provided', async () => {
    mockQueryRouter();
    await expect(selectAlmacenSession({ userId: 1, id_almacen: null }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('throws 404 for an inactive/missing user', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM usuarios u') && sql.includes('WHERE u.id_usuario = ?')) return [];
      throw new Error(`Unmocked query in test: ${sql.slice(0, 80)}`);
    });
    await expect(selectAlmacenSession({ userId: 999, id_almacen: 10 }))
      .rejects.toMatchObject({ status: 404 });
  });
});
