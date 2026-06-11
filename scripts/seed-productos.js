import '../src/config/env.js';
import { pool, query } from '../src/config/db.js';

// Laboratorios reales: Biocold SAS(2), Genfar(3), Bayer(6), MK(4), Pfizer(5)
// Formas reales: Tableta(1), Cápsula(2), Jarabe(3), Solución oral(4), Solución inyectable(5)
// Clasificaciones: RIESGO I, RIESGO IIa, RIESGO IIb, RIESGO III

const lastCum = (s) => {
  const m = String(s).match(/[.\-](\w+)$/);
  return m ? m[1] : String(s);
};

const productos = [
  {
    sku: 'MX01',
    nombre_comercial: 'Amoxicilina 500 mg Cápsulas',
    principio_activo: 'AMOXICILINA TRIHIDRATO',
    concentracion: '500 MG',
    presentacion: '20 CÁPSULAS / CAJA',
    unidad_medida: 'CAP',
    registro_invima: 'INVIMA2019M-0012345-R1',
    cum: 19872341,
    consecutivo_cum: '5635636-1',
    id_laboratorio: 3, // Genfar S.A.
    tipo_producto: 'medicamento',
    clasificacion: 'RIESGO I',
    codigo_atc: null,
    id_forma: 2, // Cápsula
    iva_tasa: 0,
    mx_control: false,
    es_controlado: false,
    requiere_cadena_frio: false,
  },
  {
    sku: 'MX02',
    nombre_comercial: 'Ibuprofeno 400 mg Tabletas',
    principio_activo: 'IBUPROFENO',
    concentracion: '400 MG',
    presentacion: '30 TABLETAS / CAJA',
    unidad_medida: 'TAB',
    registro_invima: 'INVIMA2018M-0054321-R1',
    cum: 19654321,
    consecutivo_cum: '5635636-2',
    id_laboratorio: 4, // MK Laboratorios
    tipo_producto: 'medicamento',
    clasificacion: 'RIESGO I',
    codigo_atc: null,
    id_forma: 1, // Tableta
    iva_tasa: 0,
    mx_control: false,
    es_controlado: false,
    requiere_cadena_frio: false,
  },
  {
    sku: 'MX03',
    nombre_comercial: 'Insulina Glargina 100 UI/ml Sol. Iny.',
    principio_activo: 'INSULINA GLARGINA',
    concentracion: '100 UI/ML',
    presentacion: '1 VIAL × 10 ML',
    unidad_medida: 'VIAL',
    registro_invima: 'INVIMA2021B-0008765-R1',
    cum: 21001234,
    consecutivo_cum: '5635636-3',
    id_laboratorio: 5, // Pfizer Colombia
    tipo_producto: 'medicamento',
    clasificacion: 'RIESGO IIb',
    codigo_atc: null,
    id_forma: 5, // Solución inyectable
    iva_tasa: 0,
    mx_control: false,
    es_controlado: false,
    requiere_cadena_frio: true,
  },
  {
    sku: 'MX04',
    nombre_comercial: 'Alprazolam 0.5 mg Tabletas',
    principio_activo: 'ALPRAZOLAM',
    concentracion: '0.5 MG',
    presentacion: '30 TABLETAS / CAJA',
    unidad_medida: 'TAB',
    registro_invima: 'INVIMA2020M-0034512-R1',
    cum: 20112233,
    consecutivo_cum: '5635636-4',
    id_laboratorio: 6, // Bayer
    tipo_producto: 'controlado',
    clasificacion: 'RIESGO IIa',
    codigo_atc: null,
    id_forma: 1, // Tableta
    iva_tasa: 0,
    mx_control: true,
    es_controlado: true,
    requiere_cadena_frio: false,
  },
  {
    sku: 'MX05',
    nombre_comercial: 'Omeprazol 20 mg Cápsulas',
    principio_activo: 'OMEPRAZOL',
    concentracion: '20 MG',
    presentacion: '14 CÁPSULAS / CAJA',
    unidad_medida: 'CAP',
    registro_invima: 'INVIMA2017M-0076543-R1',
    cum: 17445566,
    consecutivo_cum: '5635636-5',
    id_laboratorio: 2, // Biocold SAS
    tipo_producto: 'medicamento',
    clasificacion: 'RIESGO IIa',
    codigo_atc: null,
    id_forma: 2, // Cápsula
    iva_tasa: 0,
    mx_control: false,
    es_controlado: false,
    requiere_cadena_frio: false,
  },
];

async function main() {
  let ok = 0;
  for (const p of productos) {
    const cumSufx = lastCum(p.consecutivo_cum);
    const codigo_control = `${p.sku}-${p.id_laboratorio}.${cumSufx}`;
    try {
      await query(
        `INSERT INTO productos
          (sku, codigo_control, nombre_comercial, principio_activo, concentracion,
           presentacion, unidad_medida, registro_invima, cum, consecutivo_cum,
           id_laboratorio, tipo_producto, clasificacion, codigo_atc, id_forma,
           iva_tasa, mx_control, es_controlado, requiere_cadena_frio, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          p.sku, codigo_control, p.nombre_comercial, p.principio_activo, p.concentracion,
          p.presentacion, p.unidad_medida, p.registro_invima, p.cum, p.consecutivo_cum,
          p.id_laboratorio, p.tipo_producto, p.clasificacion, p.codigo_atc, p.id_forma,
          p.iva_tasa, p.mx_control ? 1 : 0, p.es_controlado ? 1 : 0, p.requiere_cadena_frio ? 1 : 0,
        ]
      );
      console.log(`✓ ${p.sku} → ${codigo_control}  |  ${p.nombre_comercial}`);
      ok++;
    } catch (err) {
      console.error(`✗ Error en ${p.sku}: ${err.message}`);
    }
  }
  console.log(`\n${ok}/5 productos insertados.`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
