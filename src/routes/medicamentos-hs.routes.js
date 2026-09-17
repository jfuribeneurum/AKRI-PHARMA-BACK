import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import { asyncHandler } from '../utils/async-handler.js';
import { hsPool } from '../config/hs-db.js';

export const medicamentosHsRouter = Router();

medicamentosHsRouter.get(
  '/',
  authRequired,
  asyncHandler(async (req, res) => {
    const search = String(req.query.search ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));

    let connection;
    try {
      connection = await hsPool.getConnection();

      let whereClause = 'WHERE m.inactivo = 0';
      const params = [];

      if (search) {
        whereClause += ` AND (m.medicamento LIKE ? OR m.nombreComercial LIKE ? OR m.principioActivo LIKE ? OR m.ATC LIKE ?)`;
        const w = `%${search}%`;
        params.push(w, w, w, w);
      }

      const [rows] = await connection.query(
        `SELECT m.id,
                m.codigo,
                m.medicamento        AS nombre,
                m.nombreComercial,
                m.ATC                AS atc,
                m.principioActivo,
                m.concentracion,
                d.descripcion        AS forma_farmaceutica,
                u.descripcion        AS unidad_dosificacion,
                (SELECT dci.dci
                   FROM suhc_new_tbl_medicine_dci md
                   JOIN suhc_new_tbl_dci dci ON dci.dci = md.dci
                  WHERE md.idMedicamento = m.id
                  ORDER BY md.dci
                  LIMIT 1)          AS codigo_dci
           FROM suhc_new_tbl_medicine m
           LEFT JOIN suhc_new_tbl_maestrasdetalle d
                  ON d.id = m.idFormaFarmaceutica AND d.idMaestra = 1
           LEFT JOIN suhc_new_tbl_maestrasdetalle u
                  ON u.id = m.idUnidadDosificacion
           ${whereClause}
           ORDER BY m.medicamento ASC
           LIMIT ?`,
        [...params, limit]
      );

      res.json({ success: true, data: rows });
    } finally {
      if (connection) connection.release();
    }
  })
);

medicamentosHsRouter.get(
  '/:id',
  authRequired,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'id inválido' });
    }

    let connection;
    try {
      connection = await hsPool.getConnection();

      const [rows] = await connection.query(
        `SELECT m.id,
                m.codigo,
                m.medicamento        AS nombre,
                m.nombreComercial,
                m.ATC                AS atc,
                m.principioActivo,
                m.concentracion,
                d.descripcion        AS forma_farmaceutica,
                u.descripcion        AS unidad_dosificacion,
                (SELECT dci.dci
                   FROM suhc_new_tbl_medicine_dci md
                   JOIN suhc_new_tbl_dci dci ON dci.dci = md.dci
                  WHERE md.idMedicamento = m.id
                  ORDER BY md.dci
                  LIMIT 1)          AS codigo_dci
           FROM suhc_new_tbl_medicine m
           LEFT JOIN suhc_new_tbl_maestrasdetalle d
                  ON d.id = m.idFormaFarmaceutica AND d.idMaestra = 1
           LEFT JOIN suhc_new_tbl_maestrasdetalle u
                  ON u.id = m.idUnidadDosificacion
          WHERE m.id = ?
          LIMIT 1`,
        [id]
      );

      if (!rows.length) {
        return res.status(404).json({ success: false, message: 'Medicamento no encontrado en HealthSphere' });
      }

      res.json({ success: true, data: rows[0] });
    } finally {
      if (connection) connection.release();
    }
  })
);
