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
                u.descripcion        AS unidad_dosificacion
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
