import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { query } from '../config/db.js';
import {
  listProducts,
  listProductsByLaboratorio,
  listAllProductsForPO,
  createProduct,
  updateProduct,
  getProductById,
  getProductByBarcode,
  listProductImages,
  saveProductImage,
  listLaboratorios,
  getNextControlCode,
  backfillCodigoDciFromHs,
  backfillFormaFarmaceuticaFromHs,
  backfillConcentracionFromHs,
  backfillCodigoAtcFromHs,
  backfillUnidadMedidaFromHs
} from '../services/product.service.js';

const productSchema = z.object({
  sku: z.string().min(2),
  codigo_barras: z.string().optional().nullable(),
  nombre_comercial: z.string().min(2),
  principio_activo: z.string().optional().nullable(),
  concentracion: z.string().optional().nullable(),
  presentacion: z.number().int().optional().nullable(),
  unidad_medida: z.string().optional(),
  registro_invima: z.string().optional().nullable(),
  // El CUM (Código Único de Medicamento) solo aplica a medicamentos/vacunas/
  // controlados en la regulación INVIMA — los dispositivos médicos, insumos
  // y reactivos se identifican por registro_invima y legítimamente no
  // tienen CUM. ~155 productos activos (154 dispositivos/insumos/reactivos)
  // no tienen cum, y antes esto era z.number().int() sin .nullable(): editar
  // cualquiera de ellos (guardando el mismo payload, sin tocar el campo)
  // fallaba con "Expected number, received null" solo por reenviar cum
  // vacío. El requisito de "obligatorio para medicamentos" se valida en el
  // frontend según tipo_producto (ver validateForm en maestro-mx.component.ts).
  cum: z.number().int().optional().nullable(),
  consecutivo_cum: z.number().int().optional().nullable(),
  id_categoria: z.number().int().optional().nullable(),
  id_forma: z.number().int().optional().nullable(),
  codigo_atc: z.string().optional().nullable(),
  codigo_dci: z.number().int().optional().nullable(),
  id_laboratorio: z.number().int({ message: 'El laboratorio es obligatorio' }),
  clasificacion: z.string().optional().nullable(),
  // No es un enum fijo: tipo_producto se gestiona desde Parámetros (grupo
  // 'tipo_producto') — product.service.js valida el valor dinámicamente
  // contra parametros_sistema (assertTipoProductoValido), igual que
  // inventory.service.js valida los tipos de movimiento.
  tipo_producto: z.string().min(1).optional(),
  mx_control: z.boolean().optional(),
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
    const search       = String(req.query.search ?? '');
    const idLaboratorio = req.query.id_laboratorio ? Number(req.query.id_laboratorio) : null;
    const lote         = String(req.query.lote ?? '');
    const data = await listProducts(search, idLaboratorio, lote);
    res.json({ success: true, data });
  })
);


// POST /products/backfill-codigo-dci — completa codigo_dci en productos ya
// creados y enlazados a HealthSphere que quedaron sin ese dato (creados
// antes de que Maestro MX empezara a traerlo desde HS). Idempotente: solo
// toca productos con codigo_dci IS NULL, se puede correr varias veces sin
// riesgo. Acción puntual de mantenimiento de datos, no un flujo del día a día.
productsRouter.post(
  '/backfill-codigo-dci',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await backfillCodigoDciFromHs(req.user?.sub ?? null);
    res.json({ success: true, data });
  })
);

// POST /products/backfill-forma-farmaceutica — completa id_forma en
// productos ya creados y enlazados a HealthSphere que quedaron sin ese dato,
// causando el bloqueo "no tiene forma farmacéutica en HealthSphere" al
// editarlos aunque HS sí la tenga. Idempotente: solo toca id_forma IS NULL.
productsRouter.post(
  '/backfill-forma-farmaceutica',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await backfillFormaFarmaceuticaFromHs(req.user?.sub ?? null);
    res.json({ success: true, data });
  })
);

// POST /products/backfill-concentracion — completa concentracion en
// productos ya creados y enlazados a HealthSphere que quedaron sin ese
// dato, aunque HS sí lo tenga. Idempotente: solo toca concentracion vacía.
productsRouter.post(
  '/backfill-concentracion',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await backfillConcentracionFromHs(req.user?.sub ?? null);
    res.json({ success: true, data });
  })
);

// POST /products/backfill-codigo-atc — completa codigo_atc en productos ya
// creados y enlazados a HealthSphere que quedaron sin ese dato.
productsRouter.post(
  '/backfill-codigo-atc',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await backfillCodigoAtcFromHs(req.user?.sub ?? null);
    res.json({ success: true, data });
  })
);

// POST /products/backfill-unidad-medida — corrige unidad_medida en
// productos ya creados y enlazados a HealthSphere que quedaron con el
// genérico "UND" en vez de la unidad real de HS (AMPOLLA, VIAL, TABLETA...).
productsRouter.post(
  '/backfill-unidad-medida',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await backfillUnidadMedidaFromHs(req.user?.sub ?? null);
    res.json({ success: true, data });
  })
);

productsRouter.get(
  '/next-control-code',
  authRequired,
  asyncHandler(async (req, res) => {
    const sku = String(req.query.sku ?? '').trim();
    const idLaboratorio = req.query.id_laboratorio ? Number(req.query.id_laboratorio) : null;
    const cum = req.query.cum != null && req.query.cum !== ''
      ? Number(req.query.cum)
      : null;
    const consecutivoCum = req.query.consecutivo_cum != null && req.query.consecutivo_cum !== ''
      ? Number(req.query.consecutivo_cum)
      : null;
    const data = await getNextControlCode(sku, idLaboratorio, cum, consecutivoCum);
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
  '/for-po',
  authRequired,
  asyncHandler(async (_req, res) => {
    const data = await listAllProductsForPO();
    res.json({ success: true, data });
  })
);

productsRouter.get(
  '/by-lab/:id',
  authRequired,
  asyncHandler(async (req, res) => {
    const data = await listProductsByLaboratorio(Number(req.params.id));
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
    const data = await createProduct(req.body, req.user?.sub ?? null);
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
    const data = await updateProduct(Number(req.params.id), req.body, req.user?.sub ?? null);
    res.json({ success: true, data });
  })
);
