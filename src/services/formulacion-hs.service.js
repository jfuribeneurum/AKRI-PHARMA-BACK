import { hsPool } from '../config/hs-db.js';

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
    conditions.push(`(p.documento LIKE ? OR p.primer_nombre LIKE ? OR p.primer_apellido LIKE ? OR p.segundo_apellido LIKE ?)`);
    params.push(wild, wild, wild, wild);
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

  return { ...formulacion, medicamentos };
}
