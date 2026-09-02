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

  const rows = await hsQuery(
    `SELECT
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
  );

  const [countRow] = await hsQuery(
    `SELECT COUNT(DISTINCT f.Id) AS total
       FROM suhc_new_tbl_formulacion f
       INNER JOIN tblpaciente p ON p.id = f.idPaciente
       LEFT JOIN suhc_new_tbl_atencion a ON a.id = f.idAtencion
       ${whereClause}`,
    params
  );

  return {
    data: rows,
    total: Number(countRow?.total ?? 0),
    page,
    limit
  };
}

export async function getFormulacionHSById(idFormulacion) {
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
  const idsHs = [...new Set(medicamentos.map(m => m.idMedicamento).filter(Boolean))];
  let productoPorIdHs = {};
  if (idsHs.length) {
    const placeholders = idsHs.map(() => '?').join(',');
    const rows = await query(
      `SELECT id_medicamento_hs, id_producto FROM productos WHERE id_medicamento_hs IN (${placeholders})`,
      idsHs
    );
    productoPorIdHs = Object.fromEntries(rows.map(r => [r.id_medicamento_hs, r.id_producto]));
  }

  // HealthSphere no reutiliza un idMedicamento estable por fármaco entre
  // formulaciones distintas (la misma "AGUJA INSULINA 31G X4MM" trae
  // cientos de idMedicamento diferentes en su historial) — cuando el id
  // exacto no matchea contra productos.id_medicamento_hs, se resuelve por
  // nombre normalizado contra el Maestro local en vez de dejarlo sin MX.
  const textosSinMatch = [...new Set(
    medicamentos
      .filter(m => !productoPorIdHs[m.idMedicamento])
      .map(m => normalizeMedText(m.nombre_medicamento))
      .filter(Boolean)
  )];
  let productoPorTexto = {};
  if (textosSinMatch.length) {
    const catalogo = await query(
      `SELECT id_producto, nombre_comercial, principio_activo FROM productos WHERE activo = TRUE`
    );
    const porTexto = new Map();
    for (const p of catalogo) {
      for (const clave of [normalizeMedText(p.nombre_comercial), normalizeMedText(p.principio_activo)]) {
        if (clave && !porTexto.has(clave)) porTexto.set(clave, p.id_producto);
      }
    }
    for (const texto of textosSinMatch) {
      if (porTexto.has(texto)) productoPorTexto[texto] = porTexto.get(texto);
    }
  }

  const medicamentosEnriquecidos = medicamentos.map(m => ({
    ...m,
    idProductoLocal: productoPorIdHs[m.idMedicamento] ?? productoPorTexto[normalizeMedText(m.nombre_medicamento)] ?? null,
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
