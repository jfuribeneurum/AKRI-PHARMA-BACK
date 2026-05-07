import { Router } from 'express';
import { asyncHandler } from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { z } from 'zod';
import { pool } from '../config/db.js';

const router = Router();

// Schema para validación
const ingresoSchema = z.object({
  referencia: z.string().min(1, 'Referencia requerida'),
  producto: z.string().min(1, 'Producto requerido'),
  cantidad: z.number().min(1, 'Cantidad debe ser mayor a 0'),
  lote: z.string().optional(),
  fecha_vencimiento: z.string().optional(),
  estado: z.enum(['pendiente', 'recibido', 'almacenado', 'cancelado']).default('pendiente')
});

// GET /ingresos - Obtener todos los ingresos
router.get('/', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const ingresos = await connection.query(`
      SELECT 
        id_ingreso,
        referencia,
        producto,
        cantidad,
        lote,
        fecha_vencimiento,
        estado,
        fecha_ingreso,
        created_at,
        updated_at
      FROM ingresos
      ORDER BY created_at DESC
    `);
    
    res.json({
      success: true,
      data: ingresos
    });
  } finally {
    connection.release();
  }
}));

// POST /ingresos - Crear nuevo ingreso
router.post('/', validate(ingresoSchema), asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { referencia, producto, cantidad, lote, fecha_vencimiento, estado } = req.body;
    
    await connection.query(`
      INSERT INTO ingresos 
      (referencia, producto, cantidad, lote, fecha_vencimiento, estado, fecha_ingreso)
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [referencia, producto, cantidad, lote || null, fecha_vencimiento || null, estado]);
    
    res.status(201).json({
      success: true,
      message: 'Ingreso creado exitosamente'
    });
  } finally {
    connection.release();
  }
}));

// GET /ingresos/:id - Obtener ingreso por ID
router.get('/:id', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [ingreso] = await connection.query(`
      SELECT * FROM ingresos WHERE id_ingreso = ?
    `, [req.params.id]);
    
    if (!ingreso) {
      return res.status(404).json({
        success: false,
        message: 'Ingreso no encontrado'
      });
    }
    
    res.json({
      success: true,
      data: ingreso
    });
  } finally {
    connection.release();
  }
}));

// PUT /ingresos/:id - Actualizar ingreso
router.put('/:id', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { referencia, producto, cantidad, lote, fecha_vencimiento, estado } = req.body;
    
    await connection.query(`
      UPDATE ingresos 
      SET referencia = ?, producto = ?, cantidad = ?, lote = ?, 
          fecha_vencimiento = ?, estado = ?, updated_at = NOW()
      WHERE id_ingreso = ?
    `, [referencia, producto, cantidad, lote, fecha_vencimiento, estado, req.params.id]);
    
    res.json({
      success: true,
      message: 'Ingreso actualizado exitosamente'
    });
  } finally {
    connection.release();
  }
}));

// DELETE /ingresos/:id - Eliminar ingreso
router.delete('/:id', asyncHandler(async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      DELETE FROM ingresos WHERE id_ingreso = ?
    `, [req.params.id]);
    
    res.json({
      success: true,
      message: 'Ingreso eliminado exitosamente'
    });
  } finally {
    connection.release();
  }
}));

export { router as ingresosRouter };
