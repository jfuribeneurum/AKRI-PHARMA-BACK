import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';

vi.mock('../../config/env.js', () => ({ env: { JWT_SECRET: 'test-secret' } }));

const { roleScope, isApiPathAllowed } = await import('../role-scope.js');

function run(role, path, query = {}) {
  const token = role ? jwt.sign({ sub: 1, role }, 'test-secret') : null;
  const req = { path, query, headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  roleScope(req, res, next);
  return { res, next };
}

describe('roleScope — rol INFORMES solo puede usar el módulo de Informes', () => {
  it.each([
    '/reports/rips-am/export',
    '/parametros/contrato/activos',
    '/auth/select-site',
    '/auth/almacenes'
  ])('permite %s', (path) => {
    const { next, res } = run('INFORMES', path, { format: 'csv' });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    '/dispensacion-hs/dispensar',
    '/reports/dispensing/export',
    '/reports/dispensing',
    '/admin/users',
    '/products',
    '/parametros/contrato',
    '/parametros',
    '/reportsx'
  ])('bloquea %s con 403', (path) => {
    const { next, res } = run('INFORMES', path);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('ADMINISTRADOR no se limita', () => {
    const { next } = run('ADMINISTRADOR', '/admin/users');
    expect(next).toHaveBeenCalled();
  });

  it.each(['excel', 'json', 'pdf', undefined])('INFORMES no puede descargar RIPS en formato %s', (format) => {
    const { next, res } = run('INFORMES', '/reports/rips-am/export', { format });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('INFORMES sí puede descargar RIPS en csv', () => {
    const { next } = run('INFORMES', '/reports/rips-am/export', { format: 'CSV' });
    expect(next).toHaveBeenCalled();
  });

  it('ADMINISTRADOR puede descargar RIPS en excel', () => {
    const { next } = run('ADMINISTRADOR', '/reports/rips-am/export', { format: 'excel' });
    expect(next).toHaveBeenCalled();
  });

  it('ADMINISTRADOR sí puede descargar Dispensación', () => {
    const { next } = run('ADMINISTRADOR', '/reports/dispensing/export');
    expect(next).toHaveBeenCalled();
  });

  it('sin token deja pasar (el router responde el 401)', () => {
    const { next } = run(null, '/admin/users');
    expect(next).toHaveBeenCalled();
  });

  it('token inválido deja pasar (el router responde el 401)', () => {
    const req = { path: '/admin/users', headers: { authorization: 'Bearer basura' } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    roleScope(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('isApiPathAllowed: roles no listados tienen acceso total', () => {
    expect(isApiPathAllowed('QUIMICO_FARMACEUTICO', '/admin/users')).toBe(true);
    expect(isApiPathAllowed(undefined, '/admin/users')).toBe(true);
  });
});
