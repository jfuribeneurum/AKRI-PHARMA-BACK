import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// El "Código DCI" del modal de Maestro no se arrastraba desde HealthSphere
// porque la consulta nunca traía el dato: no existe una columna DCI directa
// en suhc_new_tbl_medicine, vive en la tabla puente
// suhc_new_tbl_medicine_dci (idMedicamento -> dci) enlazada a
// suhc_new_tbl_dci (dci -> nombre).
const routeFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../medicamentos-hs.routes.js'
);
const source = readFileSync(routeFile, 'utf8');

describe('medicamentos-hs.routes source guards', () => {
  it('selects codigo_dci by joining the medicine_dci bridge table to the dci catalog', () => {
    expect(source).toMatch(/suhc_new_tbl_medicine_dci/);
    expect(source).toMatch(/suhc_new_tbl_dci/);
    expect(source).toMatch(/AS codigo_dci/);
  });
});
