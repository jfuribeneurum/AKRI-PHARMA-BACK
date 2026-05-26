import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { hsPool } from '../config/hs-db.js';

const router = Router();

const TABLA = 'tblpaciente';

// GET /api/pacientes?buscar=xxx&pagina=1&limite=50
router.get('/', asyncHandler(async (req, res) => {
  const buscar = String(req.query.buscar ?? '').trim();
  const pagina = Math.max(1, Number(req.query.pagina  ?? 1));
  const limite = Math.min(200, Math.max(1, Number(req.query.limite ?? 50)));
  const offset = (pagina - 1) * limite;

  let connection;
  try {
    connection = await hsPool.getConnection();

    let whereClause = '';
    const params = [];

    if (buscar) {
      whereClause = `
        WHERE LOWER(CONCAT_WS(' ',
          COALESCE(primer_nombre,''), COALESCE(segundo_nombre,''),
          COALESCE(primer_apellido,''), COALESCE(segundo_apellido,''),
          COALESCE(documento,''), COALESCE(correo,''),
          COALESCE(celular,''), COALESCE(telefono,'')
        )) LIKE ?`;
      params.push(`%${buscar.toLowerCase()}%`);
    }

    const [[{ total }]] = await connection.query(
      `SELECT COUNT(*) AS total FROM ${TABLA} ${whereClause}`,
      params
    );

    const [pacientes] = await connection.query(
      `SELECT
         id, tipo_documento, documento,
         primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
         fecha_nacimiento, sexo, estado, estado_paciente,
         celular, telefono, correo,
         direccion, mupio_residencia, depto_residencia,
         aseguradora, regimen, fecha_registro
       FROM ${TABLA} ${whereClause}
       ORDER BY primer_apellido ASC, primer_nombre ASC
       LIMIT ? OFFSET ?`,
      [...params, limite, offset]
    );

    res.json({
      success: true,
      data: pacientes,
      meta: {
        total: Number(total),
        pagina,
        limite,
        paginas: Math.ceil(Number(total) / limite)
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    if (connection) connection.release();
  }
}));

// GET /api/pacientes/:id
router.get('/:id', asyncHandler(async (req, res) => {
  let connection;
  try {
    connection = await hsPool.getConnection();
    const [[paciente]] = await connection.query(
      `SELECT * FROM ${TABLA} WHERE id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!paciente) {
      return res.status(404).json({ success: false, message: 'Paciente no encontrado' });
    }
    // Excluir foto (longtext pesado) del detalle básico
    delete paciente.foto;
    res.json({ success: true, data: paciente });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    if (connection) connection.release();
  }
}));

export { router as pacientesRouter };
