import { hsPool } from '../config/hs-db.js';
import { query } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';

// Los medicamentos agregados manualmente (no vienen de HealthSphere) se
// exponen con un id_med_formulacion desplazado para que nunca choque con un
// Id real de suhc_new_tbl_formulacion_medicamentos, y así puedan fluir por
// el mismo flujo de dispensación (dispensacion_hs_control) que los de HS.
const MEDICAMENTO_EXTRA_ID_OFFSET = 900000000;

function normalizeMedText(s) {
  return (s ?? '').toString().trim().toUpperCase().replace(/\s+/g, ' ');
}

// HealthSphere y el Maestro local a veces escriben el mismo nombre con
// espacios distintos entre número y unidad ("X4 MM" vs "X4MM", "50 MG" vs
// "50MG") — quitar todos los espacios es un match mecánico seguro (mismo
// texto, cero ambigüedad clínica), a diferencia de intentar equiparar formas
// farmacéuticas distintas (tableta/cápsula), que sí requiere criterio humano.
function stripSpaces(s) {
  return normalizeMedText(s).replace(/\s+/g, '');
}

async function hsQuery(sql, params = []) {
  let connection;
  try {
    connection = await hsPool.getConnection();
    const [rows] = await connection.query(sql, params);
    return rows;
  } finally {
    if (connection) connection.release();
  }
}

export async function listFormulacionesHS({ search = '', page = 1, limit = 30, fechaDesde = '', fechaHasta = '' } = {}) {
  const offset    = (Math.max(1, page) - 1) * limit;
  const wild      = `%${search.trim()}%`;
  const hasSearch = search.trim() !== '';

  const conditions = [`f.tipo = 'medicine'`];
  const params     = [];

  if (hasSearch) {
    conditions.push(`(p.documento LIKE ? OR p.primer_nombre LIKE ? OR p.primer_apellido LIKE ? OR p.segundo_apellido LIKE ? OR a.consecutivo LIKE ?)`);
    params.push(wild, wild, wild, wild, wild);
  }
  if (fechaDesde) {
    conditions.push(`f.fechaFormulacion >= ?`);
    params.push(fechaDesde);
  }
  if (fechaHasta) {
    conditions.push(`f.fechaFormulacion <= ?`);
    params.push(fechaHasta);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // HealthSphere no tiene índice en tipo/fechaFormulacion (es una base
  // externa de solo lectura para nosotros — no podemos crear índices ahí).
  // Sin texto de búsqueda, el filtro completo (tipo + rango de fechas) vive
  // en suhc_new_tbl_formulacion sola, así que se filtra/ordena/pagina AHÍ
  // primero y el JOIN con paciente/atención (336k y 241k filas) se hace
  // solo sobre la página ya resuelta (30 filas), en vez de sobre todo el
  // universo antes de ordenar. Medido: ~3.2s → ~0.25s. Con texto de
  // búsqueda no se puede evitar el JOIN antes de filtrar (busca por nombre/
  // documento de paciente), así que ahí solo se fuerza el orden del JOIN
  // con STRAIGHT_JOIN para que no arranque por tblpaciente completa.
  // El listado y el conteo son lecturas independientes — corren en paralelo
  // (2 conexiones del pool) en vez de una detrás de la otra.
  let rows;
  let countRow;

  if (hasSearch) {
    const [rowsResult, countRows] = await Promise.all([
      hsQuery(
        `SELECT STRAIGHT_JOIN
            f.Id                                    AS id_formulacion,
            f.idPaciente,
            f.fechaFormulacion,
            f.tipo,
            f.subtipo,
            a.consecutivo                           AS consecutivo_atencion,
            TRIM(CONCAT(
              COALESCE(p.primer_nombre, ''), ' ',
              COALESCE(p.segundo_nombre, ''), ' ',
              COALESCE(p.primer_apellido, ''), ' ',
              COALESCE(p.segundo_apellido, '')
            ))                                      AS nombre_paciente,
            p.documento                             AS documento_paciente,
            p.telefono                              AS telefono_paciente,
            p.celular                               AS celular_paciente,
            COUNT(fm.Id)                            AS total_medicamentos
         FROM suhc_new_tbl_formulacion f
         INNER JOIN tblpaciente p ON p.id = f.idPaciente
         LEFT JOIN suhc_new_tbl_formulacion_medicamentos fm ON fm.idFormulacion = f.Id
         LEFT JOIN suhc_new_tbl_atencion a ON a.id = f.idAtencion
         ${whereClause}
         GROUP BY f.Id
         ORDER BY f.fechaFormulacion DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      ),
      hsQuery(
        `SELECT COUNT(DISTINCT f.Id) AS total
           FROM suhc_new_tbl_formulacion f
           INNER JOIN tblpaciente p ON p.id = f.idPaciente
           LEFT JOIN suhc_new_tbl_atencion a ON a.id = f.idAtencion
           ${whereClause}`,
        params
      )
    ]);
    rows = rowsResult;
    [countRow] = countRows;
  } else {
    const [rowsResult, countRows] = await Promise.all([
      hsQuery(
        `SELECT
            f.id_formulacion,
            f.idPaciente,
            f.fechaFormulacion,
            f.tipo,
            f.subtipo,
            a.consecutivo                           AS consecutivo_atencion,
            TRIM(CONCAT(
              COALESCE(p.primer_nombre, ''), ' ',
              COALESCE(p.segundo_nombre, ''), ' ',
              COALESCE(p.primer_apellido, ''), ' ',
              COALESCE(p.segundo_apellido, '')
            ))                                      AS nombre_paciente,
            p.documento                             AS documento_paciente,
            p.telefono                              AS telefono_paciente,
            p.celular                               AS celular_paciente,
            (SELECT COUNT(*) FROM suhc_new_tbl_formulacion_medicamentos fm2
              WHERE fm2.idFormulacion = f.id_formulacion) AS total_medicamentos
         FROM (
           SELECT f.Id AS id_formulacion, f.idPaciente, f.idAtencion, f.fechaFormulacion, f.tipo, f.subtipo
             FROM suhc_new_tbl_formulacion f
             ${whereClause}
             ORDER BY f.fechaFormulacion DESC
             LIMIT ? OFFSET ?
         ) f
         INNER JOIN tblpaciente p ON p.id = f.idPaciente
         LEFT JOIN suhc_new_tbl_atencion a ON a.id = f.idAtencion`,
        [...params, limit, offset]
      ),
      hsQuery(
        `SELECT COUNT(*) AS total FROM suhc_new_tbl_formulacion f ${whereClause}`,
        params
      )
    ]);
    rows = rowsResult;
    [countRow] = countRows;
  }

  return {
    data: rows,
    total: Number(countRow?.total ?? 0),
    page,
    limit
  };
}

export async function getFormulacionHSById(idFormulacion, idSede = null) {
  const [formulacion] = await hsQuery(
    `SELECT
        f.Id                AS id_formulacion,
        f.idPaciente,
        f.idAtencion,
        f.idEspecialista,
        f.fechaFormulacion,
        f.tipo,
        f.subtipo,
        a.consecutivo       AS consecutivo_atencion,
        TRIM(CONCAT(
          COALESCE(p.primer_nombre, ''), ' ',
          COALESCE(p.segundo_nombre, ''), ' ',
          COALESCE(p.primer_apellido, ''), ' ',
          COALESCE(p.segundo_apellido, '')
        ))                  AS nombre_paciente,
        p.documento         AS documento_paciente,
        p.telefono          AS telefono_paciente,
        p.celular           AS celular_paciente,
        p.direccion         AS direccion_paciente,
        p.fecha_nacimiento  AS fecha_nacimiento_paciente,
        p.sexo              AS sexo_paciente
     FROM suhc_new_tbl_formulacion f
     INNER JOIN tblpaciente p ON p.id = f.idPaciente
     LEFT JOIN suhc_new_tbl_atencion a ON a.id = f.idAtencion
     WHERE f.Id = ? AND f.tipo = 'medicine'`,
    [idFormulacion]
  );

  if (!formulacion) return null;

  const medicamentos = await hsQuery(
    `SELECT
        fm.Id               AS id_med_formulacion,
        fm.idMedicamento,
        fm.medicamento      AS nombre_medicamento,
        fm.viaAdministracion,
        fm.unidadDosificacion,
        fm.posologia,
        fm.cantidad,
        fm.presentacion,
        fm.dx               AS diagnostico,
        fm.observaciones,
        fm.vigenciaInicio,
        fm.vigenciaFin,
        (fm.PBS = 0x31)     AS pbs
     FROM suhc_new_tbl_formulacion_medicamentos fm
     WHERE fm.idFormulacion = ?
     ORDER BY fm.Id ASC`,
    [idFormulacion]
  );

  // fm.idMedicamento es el id del medicamento en HealthSphere, no el
  // id_producto local — son dos bases de datos distintas. Se resuelve aquí
  // el id_producto real (si el medicamento ya está enlazado en Maestro) para
  // que el modal de dispensación pueda consultar/descontar el inventario
  // local correcto, en vez de usar el id de HS como si fuera un id_producto.
  //
  // Dos problemas reales del catálogo de HealthSphere obligan a que esto sea
  // más que un simple lookup 1:1:
  //  1) HS no reutiliza un idMedicamento estable por fármaco entre
  //     formulaciones (la misma "AGUJA INSULINA 31G X4MM" trae cientos de
  //     idMedicamento distintos en su historial) — cuando el id exacto no
  //     matchea contra productos.id_medicamento_hs, se resuelve por nombre
  //     normalizado contra el Maestro local.
  //  2) Un mismo genérico de HS a veces corresponde a más de un producto
  //     local (dos marcas distintas, ej. lancetas Accu-Chek vs Glucoquick,
  //     cargadas para sedes distintas) — cuando hay más de un candidato para
  //     el mismo idMedicamento/nombre, se desempata por cuál tiene stock real
  //     en la sede de quien dispensa, en vez de quedarse con el que llegue
  //     último de una consulta sin ORDER BY.
  const idsHs = [...new Set(medicamentos.map(m => m.idMedicamento).filter(Boolean))];
  const candidatosPorIdHs = new Map();
  if (idsHs.length) {
    const placeholders = idsHs.map(() => '?').join(',');
    const rows = await query(
      `SELECT id_medicamento_hs, id_producto FROM productos WHERE id_medicamento_hs IN (${placeholders})`,
      idsHs
    );
    for (const r of rows) {
      const arr = candidatosPorIdHs.get(r.id_medicamento_hs) ?? [];
      arr.push(r.id_producto);
      candidatosPorIdHs.set(r.id_medicamento_hs, arr);
    }
  }

  const textosSinMatch = [...new Set(
    medicamentos
      .filter(m => !candidatosPorIdHs.get(m.idMedicamento)?.length)
      .map(m => normalizeMedText(m.nombre_medicamento))
      .filter(Boolean)
  )];
  const candidatosPorTexto = new Map();
  const candidatosPorTextoSinEspacios = new Map();
  if (textosSinMatch.length) {
    const catalogo = await query(
      `SELECT id_producto, nombre_comercial, principio_activo FROM productos WHERE activo = TRUE`
    );
    for (const p of catalogo) {
      for (const raw of [p.nombre_comercial, p.principio_activo]) {
        const clave = normalizeMedText(raw);
        if (clave && textosSinMatch.includes(clave)) {
          const arr = candidatosPorTexto.get(clave) ?? [];
          if (!arr.includes(p.id_producto)) arr.push(p.id_producto);
          candidatosPorTexto.set(clave, arr);
        }
        const claveSinEspacios = stripSpaces(raw);
        if (claveSinEspacios) {
          const arr = candidatosPorTextoSinEspacios.get(claveSinEspacios) ?? [];
          if (!arr.includes(p.id_producto)) arr.push(p.id_producto);
          candidatosPorTextoSinEspacios.set(claveSinEspacios, arr);
        }
      }
    }
  }

  const candidatosDe = (m) =>
    candidatosPorIdHs.get(m.idMedicamento) ??
    candidatosPorTexto.get(normalizeMedText(m.nombre_medicamento)) ??
    candidatosPorTextoSinEspacios.get(stripSpaces(m.nombre_medicamento)) ??
    [];

  const idsAmbiguos = new Set();
  for (const m of medicamentos) {
    const candidatos = candidatosDe(m);
    if (candidatos.length > 1) candidatos.forEach(id => idsAmbiguos.add(id));
  }
  const stockPorProducto = new Map();
  if (idsAmbiguos.size) {
    const placeholders = [...idsAmbiguos].map(() => '?').join(',');
    const params = [...idsAmbiguos];
    const sedeClause = idSede != null ? ' AND a.id_sede = ?' : '';
    if (idSede != null) params.push(idSede);
    const stockRows = await query(
      `SELECT l.id_producto, SUM(e.cantidad_disponible) AS total
         FROM lotes l
         INNER JOIN existencias e ON e.id_lote = l.id_lote
         INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
        WHERE l.id_producto IN (${placeholders})${sedeClause}
        GROUP BY l.id_producto`,
      params
    );
    for (const r of stockRows) stockPorProducto.set(r.id_producto, Number(r.total));
  }

  function resolverIdProducto(m) {
    const candidatos = candidatosDe(m);
    if (!candidatos.length) return null;
    if (candidatos.length === 1) return candidatos[0];
    return [...candidatos].sort(
      (a, b) => (stockPorProducto.get(b) ?? 0) - (stockPorProducto.get(a) ?? 0) || a - b
    )[0];
  }

  // idsProductoCandidatos va aparte de idProductoLocal: cuando el mismo
  // genérico está cargado en más de un producto local (catálogo duplicado),
  // idProductoLocal es solo el "ganador" (más stock en la sede), pero el
  // resto de candidatos también puede tener stock real repartido en la
  // misma sede — el llamador (consulta de stock del modal de dispensación)
  // necesita verlos todos para no perder ese inventario de la vista.
  const medicamentosEnriquecidos = medicamentos.map(m => ({
    ...m,
    idProductoLocal: resolverIdProducto(m),
    idsProductoCandidatos: candidatosDe(m),
    esManual: false
  }));

  const [extras, exclusiones] = await Promise.all([
    query(
      `SELECT id, id_producto, nombre_medicamento, presentacion, via_administracion, cantidad, diagnostico, observaciones
         FROM dispensacion_hs_medicamentos_extra
        WHERE id_formulacion_hs = ? AND activo = 1
        ORDER BY id ASC`,
      [idFormulacion]
    ),
    query(
      `SELECT id_med_formulacion_hs FROM dispensacion_hs_exclusiones WHERE id_formulacion_hs = ?`,
      [idFormulacion]
    )
  ]);

  const extrasComoMedicamento = extras.map(e => ({
    id_med_formulacion: MEDICAMENTO_EXTRA_ID_OFFSET + Number(e.id),
    idMedicamento: null,
    nombre_medicamento: e.nombre_medicamento,
    viaAdministracion: e.via_administracion,
    unidadDosificacion: null,
    posologia: null,
    cantidad: e.cantidad,
    presentacion: e.presentacion,
    diagnostico: e.diagnostico,
    observaciones: e.observaciones,
    vigenciaInicio: null,
    vigenciaFin: null,
    pbs: 0,
    idProductoLocal: e.id_producto,
    idsProductoCandidatos: e.id_producto ? [e.id_producto] : [],
    esManual: true,
    idMedicamentoExtra: e.id
  }));

  const idsExcluidos = new Set(exclusiones.map(e => Number(e.id_med_formulacion_hs)));
  const medicamentosFinal = [...medicamentosEnriquecidos, ...extrasComoMedicamento]
    .filter(m => !idsExcluidos.has(Number(m.id_med_formulacion)));

  return { ...formulacion, medicamentos: medicamentosFinal };
}

// idFormulacion en HealthSphere es de solo lectura y viene de otra base —
// nada impide, a nivel de tipos, que alguien mande un id que no existe.
// Excluir o agregar medicamentos contra un id inexistente dejaría filas
// huérfanas silenciosas en las tablas locales, así que se valida primero.
async function assertFormulacionExiste(idFormulacionHs) {
  const [row] = await hsQuery(
    `SELECT Id FROM suhc_new_tbl_formulacion WHERE Id = ? AND tipo = 'medicine'`,
    [idFormulacionHs]
  );
  if (!row) {
    throw new HttpError(404, 'Formulación no encontrada en HealthSphere');
  }
}

// "Elimina" un medicamento formulado de la vista de dispensación. El origen
// (HealthSphere) es de solo lectura y no se toca — se guarda localmente que
// este medicamento queda excluido, con trazabilidad de quién y cuándo.
export async function excluirMedicamentoFormulado(idFormulacionHs, idMedFormulacionHs, nombreMedicamento, userId, motivo = null, idSede = null) {
  await assertFormulacionExiste(idFormulacionHs);
  await query(
    `INSERT IGNORE INTO dispensacion_hs_exclusiones
       (id_formulacion_hs, id_med_formulacion_hs, nombre_medicamento, motivo, id_usuario)
     VALUES (?, ?, ?, ?, ?)`,
    [idFormulacionHs, idMedFormulacionHs, nombreMedicamento ?? null, motivo, userId ?? null]
  );
  await recordProcessTrace(null, {
    proceso: 'DISPENSACION',
    subproceso: 'EXCLUIR_MEDICAMENTO_FORMULACION',
    id_sede: idSede,
    id_usuario: userId ?? null,
    referencia_tipo: 'FORMULACION_HS',
    referencia_id: idFormulacionHs,
    descripcion: `Medicamento excluido de la dispensación: ${nombreMedicamento ?? ''}`.trim(),
    payload_json: { id_med_formulacion_hs: idMedFormulacionHs, motivo: motivo ?? null }
  });
  return { id_formulacion_hs: idFormulacionHs, id_med_formulacion_hs: idMedFormulacionHs, excluido: true };
}

export async function restaurarMedicamentoExcluido(idFormulacionHs, idMedFormulacionHs, userId = null, idSede = null) {
  await query(
    `DELETE FROM dispensacion_hs_exclusiones WHERE id_formulacion_hs = ? AND id_med_formulacion_hs = ?`,
    [idFormulacionHs, idMedFormulacionHs]
  );
  await recordProcessTrace(null, {
    proceso: 'DISPENSACION',
    subproceso: 'RESTAURAR_MEDICAMENTO_EXCLUIDO',
    id_sede: idSede,
    id_usuario: userId ?? null,
    referencia_tipo: 'FORMULACION_HS',
    referencia_id: idFormulacionHs,
    descripcion: 'Medicamento restaurado a la dispensación (exclusión deshecha)',
    payload_json: { id_med_formulacion_hs: idMedFormulacionHs }
  });
  return { id_formulacion_hs: idFormulacionHs, id_med_formulacion_hs: idMedFormulacionHs, excluido: false };
}

// Agrega un medicamento manual a una formulación (ej. algo que el médico no
// alcanzó a formular en HealthSphere). Siempre debe corresponder a un
// producto ya existente en el Maestro local (id_producto), nunca texto
// libre — así queda disponible para dispensar (descuento de inventario por
// lote) igual que el resto de medicamentos.
export async function agregarMedicamentoExtra(idFormulacionHs, payload, userId, idSede = null) {
  const { id_producto, presentacion = null, via_administracion = null, cantidad, diagnostico = null, observaciones = null } = payload;

  await assertFormulacionExiste(idFormulacionHs);

  const [producto] = await query(`SELECT nombre_comercial FROM productos WHERE id_producto = ? AND activo = TRUE`, [id_producto]);
  if (!producto) {
    throw new HttpError(404, 'El medicamento seleccionado no existe en el Maestro de productos.');
  }

  // Sin esto, reintentar "Agregar medicamento" (ej. porque el stock tardó en
  // cargar en la fila anterior y pareció que no había funcionado) crea una
  // fila duplicada por cada intento — visto en producción: hasta 4 copias
  // del mismo medicamento en una sola formulación.
  const [yaAgregado] = await query(
    `SELECT id FROM dispensacion_hs_medicamentos_extra
      WHERE id_formulacion_hs = ? AND id_producto = ? AND activo = 1
      LIMIT 1`,
    [idFormulacionHs, id_producto]
  );
  if (yaAgregado) {
    throw new HttpError(409, `${producto.nombre_comercial} ya fue agregado a esta formulación.`);
  }

  const result = await query(
    `INSERT INTO dispensacion_hs_medicamentos_extra
       (id_formulacion_hs, id_producto, nombre_medicamento, presentacion, via_administracion, cantidad, diagnostico, observaciones, id_usuario_creador)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [idFormulacionHs, id_producto, producto.nombre_comercial, presentacion, via_administracion, cantidad, diagnostico, observaciones, userId ?? null]
  );

  await recordProcessTrace(null, {
    proceso: 'DISPENSACION',
    subproceso: 'AGREGAR_MEDICAMENTO_EXTRA',
    id_sede: idSede,
    id_usuario: userId ?? null,
    referencia_tipo: 'FORMULACION_HS',
    referencia_id: idFormulacionHs,
    descripcion: `Medicamento manual agregado: ${producto.nombre_comercial}`,
    payload_json: { id_producto, cantidad, presentacion, via_administracion }
  });

  return { id_med_formulacion: MEDICAMENTO_EXTRA_ID_OFFSET + Number(result.insertId), esManual: true };
}

// total_medicamentos (de listFormulacionesHS) cuenta directo lo que hay en
// HealthSphere, sin restar exclusiones ni sumar medicamentos manuales — eso
// desincroniza el estado agregado (Pendiente/Parcial/Dispensado) de la lista
// y el filtro por estado, que dependen de comparar dispensados vs ese total.
// Esta función trae, para un lote de formulaciones, cuántos están excluidos
// y cuántos manuales activos tiene cada una, para poder corregir el total.
export async function getExclusionYExtraCounts(idsFormulacion) {
  const result = {};
  for (const id of idsFormulacion) result[id] = { excluidos: 0, extras: 0 };
  if (!idsFormulacion.length) return result;

  const placeholders = idsFormulacion.map(() => '?').join(',');
  const [exclusiones, extras] = await Promise.all([
    query(
      `SELECT id_formulacion_hs, COUNT(*) AS n
         FROM dispensacion_hs_exclusiones
        WHERE id_formulacion_hs IN (${placeholders})
        GROUP BY id_formulacion_hs`,
      idsFormulacion
    ),
    query(
      `SELECT id_formulacion_hs, COUNT(*) AS n
         FROM dispensacion_hs_medicamentos_extra
        WHERE id_formulacion_hs IN (${placeholders}) AND activo = 1
        GROUP BY id_formulacion_hs`,
      idsFormulacion
    )
  ]);
  for (const r of exclusiones) result[r.id_formulacion_hs].excluidos = Number(r.n);
  for (const r of extras) result[r.id_formulacion_hs].extras = Number(r.n);
  return result;
}

// Para el informe RIPS (archivo AM) se necesitan varios datos que solo
// existen en HealthSphere, nunca en la base local:
//  - dx: diagnóstico CIE-10, guardado como texto libre "CODIGO-Descripción"
//    (ej. "E109-Diabetes mellitus insulinodependiente...") — se extrae el
//    código tomando todo antes del primer guion.
//  - concentracion: la de suhc_new_tbl_medicine (catálogo real de HS,
//    enlazado por idMedicamento), NO la del Maestro local — el usuario pidió
//    explícitamente "concentración HS", no la registrada en AkriPharmacy.
//  - unidadDosificacion (de fm, por renglón de fórmula): HS lo guarda YA
//    como texto legible (ej. "TABLETA", "AMPOLLA") — no hay que resolver
//    ningún código para este.
//  - forma farmacéutica: SÍ existe catálogo real en HS —
//    suhc_new_tbl_maestrasdetalle, filtrado por idMaestra = 1 — el mismo
//    que usa medicamentos-hs.routes.js para resolver este mismo campo en
//    el buscador de "Medicamento base (HealthSphere)" del Maestro MX. Se
//    corrige acá: ya NO se usa fm.presentacion como sustituto.
//  - unidad mínima de dispensación: si el medicamento "tiene cálculo"
//    (medicine.conCalculo = 1, ej. factores de coagulación/insulinas en
//    PEN o VIAL), la unidad real es medicine.idUnidadCalculo, que TAMBIÉN
//    resuelve contra suhc_new_tbl_maestrasdetalle (sin filtro de idMaestra
//    — igual que hace medicamentos-hs.routes.js para "unidad dosificación").
//    Si no tiene cálculo, se usa fm.unidadDosificacion (ya viene como texto
//    legible por cada renglón de la fórmula).
//  - temporalidad: el formato pedido es "cada X horas durante Y días", igual
//    a como HS lo imprime en el PDF de la formulación. Se arma con dos pares
//    de columnas: fm.posologiaTipoCantidad + fm.posologiaTipo (frecuencia,
//    ej. "cada 6 horas") y fm.temporalidad + fm.temporalidadTipo (duración,
//    ej. "durante 2 días"). HS NO tiene un catálogo para los códigos de
//    unidad (0/1/2/3, ni en suhc_new_tbl_maestrasdetalle ni en ningún otro
//    lado) — se infirieron cruzando cientos de registros reales contra su
//    posología en texto (ej. SEMAGLUTIDA "aplicar 0.25mg sc cada semana" con
//    tipo=2; BUPROPION 1 tableta/día con tipo=1 y cantidad=90 para 90 días):
//    0=horas, 1=días, 2=semanas, 3=meses. Un código fuera de 0-3 (no debería
//    ocurrir, no se ha visto en datos reales) se entrega crudo como
//    "COD-<n>" en vez de inventar una unidad.
const UNIDADES_TEMPORALES = { 0: 'horas', 1: 'días', 2: 'semanas', 3: 'meses' };

function formatearUnidadTemporal(cantidad, tipo) {
  if (cantidad == null) return null;
  const unidad = UNIDADES_TEMPORALES[Number(tipo)] ?? `COD-${tipo}`;
  return `${cantidad} ${unidad}`;
}

export async function getDxPorIdMedFormulacion(idsMedFormulacion) {
  const result = {};
  const ids = [...new Set(idsMedFormulacion.filter(Boolean))];
  if (!ids.length) return result;

  const placeholders = ids.map(() => '?').join(',');
  const rows = await hsQuery(
    `SELECT fm.Id, fm.dx, fm.unidadDosificacion,
            fm.posologiaTipoCantidad, fm.posologiaTipo, fm.temporalidad, fm.temporalidadTipo,
            med.concentracion, med.conCalculo, med.idUnidadCalculo,
            forma.descripcion AS forma_farmaceutica,
            unidadCalculo.descripcion AS unidad_calculo
       FROM suhc_new_tbl_formulacion_medicamentos fm
       LEFT JOIN suhc_new_tbl_medicine med ON med.id = fm.idMedicamento
       LEFT JOIN suhc_new_tbl_maestrasdetalle forma
              ON forma.id = med.idFormaFarmaceutica AND forma.idMaestra = 1
       LEFT JOIN suhc_new_tbl_maestrasdetalle unidadCalculo
              ON unidadCalculo.id = med.idUnidadCalculo
      WHERE fm.Id IN (${placeholders})`,
    ids
  );
  for (const r of rows) {
    const dx = (r.dx ?? '').toString().trim();
    const separador = dx.indexOf('-');
    const unidadDosificacion = (r.unidadDosificacion ?? '').toString().trim() || null;
    const unidadCalculoTexto = (r.unidad_calculo ?? '').toString().trim() || null;
    const tieneCalculo = Number(r.conCalculo) === 1;

    const frecuencia = formatearUnidadTemporal(r.posologiaTipoCantidad, r.posologiaTipo);
    const duracion = formatearUnidadTemporal(r.temporalidad, r.temporalidadTipo);
    const temporalidadTexto = frecuencia && duracion
      ? `cada ${frecuencia} durante ${duracion}`
      : (duracion ? `durante ${duracion}` : null);

    result[r.Id] = {
      dx_completo: dx || null,
      cie10: separador > 0 ? dx.slice(0, separador).trim() : (dx || null),
      concentracion_hs: (r.concentracion ?? '').toString().trim() || null,
      unidad_dosificacion_hs: unidadDosificacion,
      forma_farmaceutica_hs: (r.forma_farmaceutica ?? '').toString().trim() || null,
      unidad_minima_dispensacion: tieneCalculo
        ? (unidadCalculoTexto ?? (r.idUnidadCalculo != null ? `COD-${r.idUnidadCalculo}` : null))
        : unidadDosificacion,
      temporalidad_hs: temporalidadTexto
    };
  }
  return result;
}

// El médico prescriptor vive a nivel de FORMULACIÓN (suhc_new_tbl_formulacion
// .idEspecialista → suhc_new_tbl_usuario), no por cada medicamento — todos
// los renglones de una misma fórmula comparten el mismo prescriptor. Cuando
// idEspecialista = 0 (formulaciones antiguas sin especialista enlazado), no
// hay prescriptor que resolver y el resultado queda null, no inventado.
export async function getPrescriptorPorIdFormulacion(idsFormulacion) {
  const result = {};
  const ids = [...new Set(idsFormulacion.filter(Boolean))];
  if (!ids.length) return result;

  const placeholders = ids.map(() => '?').join(',');
  const rows = await hsQuery(
    `SELECT f.Id, u.tipo_documento, u.documento
       FROM suhc_new_tbl_formulacion f
       LEFT JOIN suhc_new_tbl_usuario u ON u.id = f.idEspecialista
      WHERE f.Id IN (${placeholders})`,
    ids
  );
  for (const r of rows) {
    result[r.Id] = {
      tipo_documento_medico: (r.tipo_documento ?? '').toString().trim() || null,
      numero_documento_medico: (r.documento ?? '').toString().trim() || null
    };
  }
  return result;
}

export async function eliminarMedicamentoExtra(idMedicamentoExtra, userId, idSede = null) {
  const [row] = await query(
    `SELECT id, id_formulacion_hs, nombre_medicamento FROM dispensacion_hs_medicamentos_extra WHERE id = ? AND activo = 1`,
    [idMedicamentoExtra]
  );
  if (!row) {
    throw new HttpError(404, 'Medicamento manual no encontrado');
  }
  await query(`UPDATE dispensacion_hs_medicamentos_extra SET activo = 0 WHERE id = ?`, [idMedicamentoExtra]);
  await recordProcessTrace(null, {
    proceso: 'DISPENSACION',
    subproceso: 'ELIMINAR_MEDICAMENTO_EXTRA',
    id_sede: idSede,
    id_usuario: userId ?? null,
    referencia_tipo: 'FORMULACION_HS',
    referencia_id: row.id_formulacion_hs,
    descripcion: `Medicamento manual eliminado: ${row.nombre_medicamento ?? ''}`.trim(),
    payload_json: { id_medicamento_extra: idMedicamentoExtra }
  });
  return { id: idMedicamentoExtra, eliminado: true };
}
