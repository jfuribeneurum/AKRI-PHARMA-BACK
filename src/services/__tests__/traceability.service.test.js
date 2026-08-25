import { describe, it, expect, vi, beforeEach } from 'vitest';

// listAuditLog() selected a.id_auditoria, but the live log_auditoria table's
// primary key is id_log — every call to GET /traceability/audit 500'd with
// "Unknown column 'a.id_auditoria' in 'SELECT'". Fixed by aliasing
// a.id_log AS id_auditoria so the API response shape stays unchanged.
vi.mock('../../config/db.js', () => ({
  query: vi.fn()
}));

const { query } = await import('../../config/db.js');
const { listAuditLog } = await import('../traceability.service.js');

describe('traceability.service listAuditLog', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('selects id_log aliased as id_auditoria instead of a non-existent column', async () => {
    query.mockResolvedValueOnce([]);

    await listAuditLog({});

    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/a\.id_log\s+AS\s+id_auditoria/i);
    expect(sql).not.toMatch(/a\.id_auditoria/i);
  });

  it('parses JSON text columns and passes through the aliased id', async () => {
    query.mockResolvedValueOnce([{
      id_auditoria: 42,
      datos_anteriores: '{"a":1}',
      datos_nuevos: null,
      campos_modificados: '["x"]',
      metadata: '{"k":"v"}'
    }]);

    const [row] = await listAuditLog({});

    expect(row.id_auditoria).toBe(42);
    expect(row.datos_anteriores).toEqual({ a: 1 });
    expect(row.datos_nuevos).toBeNull();
    expect(row.campos_modificados).toEqual(['x']);
    expect(row.metadata).toEqual({ k: 'v' });
  });
});
