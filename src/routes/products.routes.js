import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query } from '../config/db.js';
import {
  listProducts,
  createProduct,
  updateProduct,
  getProductById,
  getProductByBarcode,
  listProductImages,
  saveProductImage,
  listLaboratorios
} from '../services/product.service.js';

const productSchema = z.object({
  sku: z.string().min(2),
  codigo_barras: z.string().optional().nullable(),
  nombre_comercial: z.string().min(2),
  principio_activo: z.string().optional().nullable(),
  concentracion: z.string().optional().nullable(),
  presentacion: z.string().optional().nullable(),
  unidad_medida: z.string().optional(),
  registro_invima: z.string().optional().nullable(),
  cum: z.number().int().optional().nullable(),
  consecutivo_cum: z.number().int().optional().nullable(),
  id_categoria: z.number().int().optional().nullable(),
  id_forma: z.number().int().optional().nullable(),
  codigo_atc: z.string().optional().nullable(),
  id_laboratorio: z.number().int().optional().nullable(),
  tipo_producto: z.enum(['medicamento', 'insumo', 'controlado', 'vacuna', 'dispositivo', 'otro']).optional(),
  mx_control: z.boolean().optional(),
  es_controlado: z.boolean().optional(),
  requiere_cadena_frio: z.boolean().optional(),
  temp_min: z.number().optional().nullable(),
  temp_max: z.number().optional().nullable(),
  iva_tasa: z.number().optional(),
  costo_referencia: z.number().optional(),
  precio_venta: z.number().optional(),
  stock_minimo: z.number().optional(),
  stock_maximo: z.number().optional(),
  punto_reorden: z.number().optional(),
  activo: z.boolean().optional(),
  id_medicamento_hs: z.number().int().optional().nullable()
});

const productMediaSchema = z.object({
  image_base64: z.string().min(32),
  tipo_origen: z.enum(['escaneada', 'importada', 'fotografia']).default('importada'),
  descripcion: z.string().max(255).optional().nullable(),
  es_principal: z.boolean().optional(),
  metadata: z.record(z.any()).optional().nullable()
});

export const productsRouter = Router();

productsRouter.get(
  '/lookups',
  authRequired,
  asyncHandler(async (_req, res) => {
    const [laboratorios, formas] = await Promise.all([
      listLaboratorios(),
      query('SELECT id_forma, nombre FROM formas_farmaceuticas ORDER BY nombre ASC')
    ]);
    res.json({ success: true, data: { laboratorios, formas } });
  })
);

productsRouter.get(
  '/',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await listProducts(String(req.query.search ?? ''));
    res.json({ success: true, data });
  })
);


productsRouter.get(
  '/barcode/:barcode',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await getProductByBarcode(String(req.params.barcode));
    if (!data) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado para el código de barras indicado' });
    }
    res.json({ success: true, data });
  })
);

productsRouter.get(
  '/:id',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await getProductById(Number(req.params.id));
    res.json({ success: true, data });
  })
);

productsRouter.get(
  '/:id/media',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await listProductImages(Number(req.params.id));
    res.json({ success: true, data });
  })
);

productsRouter.post(
  '/',
  authRequired,
  validate(productSchema),
  asyncHandler(async (req, res) => {
    const data = await createProduct(req.body);
    res.status(201).json({ success: true, data });
  })
);

productsRouter.post(
  '/:id/media',
  authRequired,
  validate(productMediaSchema),
  asyncHandler(async (req, res) => {
    const data = await saveProductImage(Number(req.params.id), req.body, req.user.sub);
    res.status(201).json({ success: true, data });
  })
);

productsRouter.put(
  '/:id',
  authRequired,
  validate(productSchema.partial()),
  asyncHandler(async (req, res) => {
    const data = await updateProduct(Number(req.params.id), req.body);
    res.json({ success: true, data });
  })
);
