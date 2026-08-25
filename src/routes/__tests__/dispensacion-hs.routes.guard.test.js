import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The JWT payload signed by auth.service.js's issueToken() carries the user id
// under `sub` (not `id_usuario` — that key never exists on req.user). This
// route used `req.user?.id_usuario` to resolve userId, which was always
// undefined, so every dispensación HS record (and its traceability entry)
// silently stored id_usuario = NULL, losing who-dispensed-what.
const routeFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dispensacion-hs.routes.js'
);
const source = readFileSync(routeFile, 'utf8');

describe('dispensacion-hs.routes source guards', () => {
  it('never reads the requesting user id from the non-existent req.user.id_usuario', () => {
    expect(source).not.toMatch(/req\.user\?\.id_usuario/);
  });

  it('resolves the requesting user id from req.user.sub (the JWT payload field)', () => {
    const matches = source.match(/req\.user\?\.sub/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
