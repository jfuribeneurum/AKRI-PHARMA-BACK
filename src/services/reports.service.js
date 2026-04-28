import { pool, query } from '../config/db.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { writeAudit } from './audit.service.js';
import { getSummary } from './dashboard.service.js';
import { listStock } from './inventory.service.js';

const MIME_TYPES = {
  json: 'application/json; charset=utf-8',
  excel: 'application/vnd.ms-excel; charset=utf-8',
  pdf: 'application/pdf'
};

function normalizeFormat(format) {
  const normalized = String(format ?? 'json').trim().toLowerCase();
  if (!['json', 'excel', 'pdf'].includes(normalized)) {
    throw new HttpError(400, 'Formato no soportado. Usa json, excel o pdf.');
  }
  return normalized;
}

function normalizeBoundedInteger(value, fallback, { min = 1, max = 3650 } = {}) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

function toNumber(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sheetName(value) {
  return String(value ?? 'Sheet')
    .replace(/[\\/:*?\[\]]/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';
}

function buildWorksheetCell(value, type) {
  if (value === null || value === undefined) {
    return '<Cell><Data ss:Type="String"></Data></Cell>';
  }

  if (type === 'number' || (type !== 'string' && typeof value === 'number')) {
    return `<Cell ss:StyleID="Number"><Data ss:Type="Number">${toNumber(value)}</Data></Cell>`;
  }

  return `<Cell ss:StyleID="DateText"><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

function buildWorksheet(sheet) {
  const columns = Array.isArray(sheet.columns) ? sheet.columns : [];
  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const columnXml = columns
    .map((column) => {
      const width = Number(column.width ?? 120);
      return `      <Column ss:AutoFitWidth="0" ss:Width="${width}"/>`;
    })
    .join('\n');

  const headerRow = `      <Row>${columns
    .map((column) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlEscape(column.label)}</Data></Cell>`)
    .join('')}</Row>`;

  const bodyRows = rows
    .map((row) => {
      const cells = columns.map((column) => buildWorksheetCell(row?.[column.key], column.type));
      return `      <Row>${cells.join('')}</Row>`;
    })
    .join('\n');

  return `  <Worksheet ss:Name="${xmlEscape(sheetName(sheet.name))}">
    <Table>
${columnXml ? `${columnXml}\n` : ''}${headerRow}
${bodyRows}
    </Table>
    <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
      <Selected/>
      <ProtectObjects>False</ProtectObjects>
      <ProtectScenarios>False</ProtectScenarios>
    </WorksheetOptions>
  </Worksheet>`;
}

function buildExcelWorkbook(sheets) {
  const workbook = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
  <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
    <Author>OpenAI</Author>
    <Company>AkriPharmacy</Company>
  </DocumentProperties>
  <Styles>
    <Style ss:ID="Default" ss:Name="Normal">
      <Alignment ss:Vertical="Center"/>
      <Borders/>
      <Font ss:FontName="Calibri" ss:Size="11"/>
      <Interior/>
      <NumberFormat/>
      <Protection/>
    </Style>
    <Style ss:ID="Header">
      <Font ss:Bold="1" ss:Color="#FFFFFF"/>
      <Interior ss:Color="#6D28D9" ss:Pattern="Solid"/>
      <Alignment ss:Vertical="Center" ss:WrapText="1"/>
    </Style>
    <Style ss:ID="Subheader">
      <Font ss:Bold="1" ss:Color="#111827"/>
      <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
    </Style>
    <Style ss:ID="Number">
      <NumberFormat ss:Format="Standard"/>
    </Style>
    <Style ss:ID="DateText">
      <NumberFormat ss:Format="@"/>
    </Style>
  </Styles>
${sheets.map(buildWorksheet).join('\n')}
</Workbook>`;

  return Buffer.from(workbook, 'utf8');
}

function asciiSafe(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\u0000-\u001F]/g, ' ')
    .replace(/[^\x20-\x7E]/g, '?');
}

function escapePdfText(value) {
  return asciiSafe(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function pad(value, width, align = 'left') {
  const text = asciiSafe(value);
  const trimmed = text.length > width ? `${text.slice(0, Math.max(0, width - 3))}...` : text;
  return align === 'right' ? trimmed.padStart(width, ' ') : trimmed.padEnd(width, ' ');
}

function tableLines(columns, rows) {
  const header = columns.map((column) => pad(column.label, column.width, column.align)).join(' | ');
  const separator = columns.map((column) => '-'.repeat(column.width)).join('-+-');
  const body = rows.map((row) => columns.map((column) => pad(row?.[column.key], column.width, column.align)).join(' | '));
  return [header, separator, ...body];
}

function buildPdfDocument({ title, subtitle, lines, landscape = true }) {
  const pageWidth = landscape ? 842 : 595;
  const pageHeight = landscape ? 595 : 842;
  const marginLeft = 28;
  const startY = pageHeight - 32;
  const lineHeight = 11;
  const maxLinesPerPage = Math.max(1, Math.floor((pageHeight - 70) / lineHeight));
  const preparedLines = [asciiSafe(title), asciiSafe(subtitle), '', ...lines.map(asciiSafe)];
  const pages = [];

  for (let index = 0; index < preparedLines.length; index += maxLinesPerPage) {
    pages.push(preparedLines.slice(index, index + maxLinesPerPage));
  }

  const objectBuffers = [];
  const fontId = 1;
  const pagesId = 2;
  let nextObjectId = 3;
  const pageIds = [];

  objectBuffers[fontId] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', 'ascii');

  for (const pageLines of pages) {
    const contentId = nextObjectId++;
    const pageId = nextObjectId++;
    pageIds.push(pageId);

    let stream = 'BT\n/F1 9 Tf\n';
    let currentY = startY;
    for (const line of pageLines) {
      stream += `1 0 0 1 ${marginLeft} ${currentY} Tm (${escapePdfText(line)}) Tj\n`;
      currentY -= lineHeight;
    }
    stream += 'ET';

    const streamBuffer = Buffer.from(stream, 'ascii');
    objectBuffers[contentId] = Buffer.from(`<< /Length ${streamBuffer.length} >>\nstream\n${stream}\nendstream`, 'ascii');
    objectBuffers[pageId] = Buffer.from(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`, 'ascii');
  }

  objectBuffers[pagesId] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'ascii');
  const catalogId = nextObjectId++;
  objectBuffers[catalogId] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'ascii');

  const chunks = [Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'binary')];
  const offsets = [0];
  let currentOffset = chunks[0].length;

  for (let id = 1; id < objectBuffers.length; id += 1) {
    const object = objectBuffers[id];
    if (!object) {
      continue;
    }

    offsets[id] = currentOffset;
    const prefix = Buffer.from(`${id} 0 obj\n`, 'ascii');
    const suffix = Buffer.from('\nendobj\n', 'ascii');
    chunks.push(prefix, object, suffix);
    currentOffset += prefix.length + object.length + suffix.length;
  }

  const xrefStart = currentOffset;
  chunks.push(Buffer.from(`xref\n0 ${objectBuffers.length}\n`, 'ascii'));
  chunks.push(Buffer.from('0000000000 65535 f \n', 'ascii'));
  for (let id = 1; id < objectBuffers.length; id += 1) {
    const offset = String(offsets[id] ?? 0).padStart(10, '0');
    chunks.push(Buffer.from(`${offset} 00000 n \n`, 'ascii'));
  }
  chunks.push(Buffer.from(`trailer\n<< /Size ${objectBuffers.length} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`, 'ascii'));

  return Buffer.concat(chunks);
}

function dashboardSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Productos activos', valor: data.counters.products },
    { metrica: 'Productos con código de barras', valor: data.counters.productsWithBarcode },
    { metrica: 'Productos con imágenes', valor: data.counters.productsWithImages },
    { metrica: 'Productos con cadena de frío', valor: data.counters.coldChainProducts },
    { metrica: 'Productos controlados', valor: data.counters.controlledProducts },
    { metrica: 'Stock bajo', valor: data.counters.lowStock },
    { metrica: 'Stock crítico', valor: data.counters.criticalStock },
    { metrica: 'Agotados', valor: data.counters.outOfStock },
    { metrica: 'Valor inventario', valor: data.counters.inventoryValue },
    { metrica: 'Lotes vencidos', valor: data.counters.expiredLots },
    { metrica: 'Vencen en 30 días', valor: data.counters.lotsExpiring30Days },
    { metrica: 'Vencen en 90 días', valor: data.counters.lotsExpiring90Days },
    { metrica: 'Alertas de cadena de frío abiertas', valor: data.counters.coldChainOpenAlerts },
    { metrica: 'Compras pendientes', valor: data.counters.purchasesPendingReceipt },
    { metrica: 'Facturas pendientes', valor: data.counters.invoicesPendingSync },
    { metrica: 'Cobertura de códigos de barras (%)', valor: data.coverage.barcodePct },
    { metrica: 'Cobertura de imágenes (%)', valor: data.coverage.imagesPct }
  ];
}

function buildDashboardExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 120, type: 'string' }
      ],
      rows: dashboardSummaryRows(data)
    },
    {
      name: 'Stock Bajo',
      columns: [
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'stock_actual', label: 'Stock actual', width: 90, type: 'number' },
        { key: 'stock_minimo', label: 'Stock mínimo', width: 90, type: 'number' },
        { key: 'severidad', label: 'Severidad', width: 90, type: 'string' }
      ],
      rows: data.lowStock
    },
    {
      name: 'Vencimientos',
      columns: [
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
        { key: 'fecha_vencimiento', label: 'Fecha vencimiento', width: 110, type: 'string' },
        { key: 'dias_para_vencer', label: 'Días', width: 70, type: 'number' },
        { key: 'cantidad_disponible', label: 'Disponible', width: 80, type: 'number' }
      ],
      rows: data.expiringLots
    },
    {
      name: 'Cadena Frio',
      columns: [
        { key: 'equipo', label: 'Equipo', width: 150, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 150, type: 'string' },
        { key: 'temperatura', label: 'Temperatura', width: 90, type: 'number' },
        { key: 'humedad', label: 'Humedad', width: 90, type: 'number' },
        { key: 'estado', label: 'Estado', width: 90, type: 'string' },
        { key: 'ultima_lectura', label: 'Última lectura', width: 140, type: 'string' }
      ],
      rows: data.coldChainStatus
    },
    {
      name: 'Movimientos 6M',
      columns: [
        { key: 'periodo', label: 'Periodo', width: 90, type: 'string' },
        { key: 'ingresos', label: 'Ingresos', width: 90, type: 'number' },
        { key: 'egresos', label: 'Egresos', width: 90, type: 'number' }
      ],
      rows: data.monthlyMovements
    }
  ]);
}

function buildDashboardPdf(data) {
  const lines = [];
  lines.push(...dashboardSummaryRows(data).map((row) => `${pad(row.metrica, 42)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'STOCK BAJO PRIORIZADO');
  lines.push(...tableLines([
    { key: 'sku', label: 'SKU', width: 12 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 34 },
    { key: 'stock_actual', label: 'ACTUAL', width: 8, align: 'right' },
    { key: 'stock_minimo', label: 'MIN', width: 8, align: 'right' },
    { key: 'severidad', label: 'SEVERIDAD', width: 11 }
  ], data.lowStock));
  lines.push('', 'LOTES PROXIMOS A VENCER');
  lines.push(...tableLines([
    { key: 'numero_lote', label: 'LOTE', width: 14 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 30 },
    { key: 'fecha_vencimiento', label: 'VENCE', width: 12 },
    { key: 'dias_para_vencer', label: 'DIAS', width: 6, align: 'right' },
    { key: 'cantidad_disponible', label: 'UNID', width: 8, align: 'right' }
  ], data.expiringLots));
  lines.push('', 'ESTADO DE CADENA DE FRIO');
  lines.push(...tableLines([
    { key: 'equipo', label: 'EQUIPO', width: 22 },
    { key: 'almacen', label: 'ALMACEN', width: 18 },
    { key: 'temperatura', label: 'TEMP', width: 7, align: 'right' },
    { key: 'humedad', label: 'HUM', width: 7, align: 'right' },
    { key: 'estado', label: 'ESTADO', width: 12 }
  ], data.coldChainStatus));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DASHBOARD DE INVENTARIO',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

function buildInventoryReport(search, rows) {
  const uniqueProducts = new Set(rows.map((row) => row.id_producto)).size;
  const uniqueLots = new Set(rows.map((row) => row.id_lote)).size;
  const totalUnits = rows.reduce((sum, row) => sum + toNumber(row.cantidad_disponible), 0);
  const totalReserved = rows.reduce((sum, row) => sum + toNumber(row.cantidad_reservada), 0);
  const totalQuarantine = rows.reduce((sum, row) => sum + toNumber(row.cantidad_cuarentena), 0);
  const estimatedValue = rows.reduce((sum, row) => sum + (toNumber(row.cantidad_disponible) * toNumber(row.costo_unitario)), 0);
  const expiring30 = rows.filter((row) => toNumber(row.dias_para_vencer) >= 0 && toNumber(row.dias_para_vencer) <= 30).length;

  const byWarehouseMap = new Map();
  for (const row of rows) {
    const key = `${row.almacen}__${row.tipo_almacen}`;
    const current = byWarehouseMap.get(key) ?? {
      almacen: row.almacen,
      tipo_almacen: row.tipo_almacen,
      registros: 0,
      unidades: 0,
      valor_estimado: 0
    };
    current.registros += 1;
    current.unidades += toNumber(row.cantidad_disponible);
    current.valor_estimado += toNumber(row.cantidad_disponible) * toNumber(row.costo_unitario);
    byWarehouseMap.set(key, current);
  }

  return {
    generatedAt: new Date().toISOString(),
    filter: search,
    summary: {
      registros: rows.length,
      productos: uniqueProducts,
      lotes: uniqueLots,
      unidades: Number(totalUnits.toFixed(3)),
      reservadas: Number(totalReserved.toFixed(3)),
      cuarentena: Number(totalQuarantine.toFixed(3)),
      valor_estimado: Number(estimatedValue.toFixed(2)),
      vencen30dias: expiring30
    },
    byWarehouse: Array.from(byWarehouseMap.values()).sort((a, b) => b.unidades - a.unidades || a.almacen.localeCompare(b.almacen)),
    rows
  };
}

function buildInventoryExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 210, type: 'string' },
        { key: 'valor', label: 'Valor', width: 120, type: 'string' }
      ],
      rows: [
        { metrica: 'Fecha de generación', valor: data.generatedAt },
        { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
        { metrica: 'Registros', valor: data.summary.registros },
        { metrica: 'Productos únicos', valor: data.summary.productos },
        { metrica: 'Lotes únicos', valor: data.summary.lotes },
        { metrica: 'Unidades disponibles', valor: data.summary.unidades },
        { metrica: 'Unidades reservadas', valor: data.summary.reservadas },
        { metrica: 'Unidades en cuarentena', valor: data.summary.cuarentena },
        { metrica: 'Valor estimado', valor: data.summary.valor_estimado },
        { metrica: 'Lotes que vencen en 30 días', valor: data.summary.vencen30dias }
      ]
    },
    {
      name: 'Inventario',
      columns: [
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'codigo_barras', label: 'Código de barras', width: 120, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 110, type: 'string' },
        { key: 'fecha_vencimiento', label: 'Vence', width: 100, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 140, type: 'string' },
        { key: 'ubicacion', label: 'Ubicación', width: 140, type: 'string' },
        { key: 'cantidad_disponible', label: 'Disponible', width: 80, type: 'number' },
        { key: 'cantidad_reservada', label: 'Reservada', width: 80, type: 'number' },
        { key: 'cantidad_cuarentena', label: 'Cuarentena', width: 90, type: 'number' },
        { key: 'costo_unitario', label: 'Costo unitario', width: 90, type: 'number' },
        { key: 'precio_venta', label: 'Precio venta', width: 90, type: 'number' },
        { key: 'dias_para_vencer', label: 'Días para vencer', width: 100, type: 'number' }
      ],
      rows: data.rows
    },
    {
      name: 'Almacenes',
      columns: [
        { key: 'almacen', label: 'Almacén', width: 160, type: 'string' },
        { key: 'tipo_almacen', label: 'Tipo', width: 110, type: 'string' },
        { key: 'registros', label: 'Registros', width: 80, type: 'number' },
        { key: 'unidades', label: 'Unidades', width: 90, type: 'number' },
        { key: 'valor_estimado', label: 'Valor estimado', width: 100, type: 'number' }
      ],
      rows: data.byWarehouse
    }
  ]);
}

function buildInventoryPdf(data) {
  const lines = [
    `${pad('Filtro', 18)} : ${asciiSafe(data.filter || 'Sin filtro')}`,
    `${pad('Registros', 18)} : ${data.summary.registros}`,
    `${pad('Productos', 18)} : ${data.summary.productos}`,
    `${pad('Lotes', 18)} : ${data.summary.lotes}`,
    `${pad('Unidades', 18)} : ${data.summary.unidades}`,
    `${pad('Reservadas', 18)} : ${data.summary.reservadas}`,
    `${pad('Cuarentena', 18)} : ${data.summary.cuarentena}`,
    `${pad('Valor estimado', 18)} : ${data.summary.valor_estimado}`,
    `${pad('Vencen 30 dias', 18)} : ${data.summary.vencen30dias}`,
    '',
    'INVENTARIO POR LOTE Y UBICACION'
  ];

  lines.push(...tableLines([
    { key: 'sku', label: 'SKU', width: 10 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 24 },
    { key: 'numero_lote', label: 'LOTE', width: 12 },
    { key: 'fecha_vencimiento', label: 'VENCE', width: 10 },
    { key: 'almacen', label: 'ALMACEN', width: 16 },
    { key: 'ubicacion', label: 'UBICACION', width: 14 },
    { key: 'cantidad_disponible', label: 'DISP', width: 7, align: 'right' },
    { key: 'cantidad_reservada', label: 'RES', width: 7, align: 'right' },
    { key: 'cantidad_cuarentena', label: 'CUAR', width: 7, align: 'right' }
  ], data.rows));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE INVENTARIO',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchPurchasesDataset(search = '') {
  const filter = String(search ?? '').trim();
  const like = `%${filter}%`;
  const where = filter
    ? `WHERE (
        oc.numero_oc LIKE ? OR p.nombre LIKE ? OR oc.estado LIKE ? OR pr.nombre_comercial LIKE ? OR pr.sku LIKE ?
      )`
    : '';
  const params = filter ? [like, like, like, like, like] : [];

  const orders = await query(
    `SELECT
        oc.id_oc,
        oc.numero_oc,
        oc.fecha,
        oc.estado,
        p.nombre AS proveedor,
        COUNT(DISTINCT ocd.id_oc_detalle) AS lineas,
        ROUND(COALESCE(SUM(ocd.cantidad), 0), 3) AS unidades_solicitadas,
        oc.subtotal,
        oc.impuestos,
        oc.total,
        COALESCE(rec.recepciones, 0) AS recepciones,
        rec.fecha_ultima_recepcion,
        ROUND(COALESCE(rec.unidades_recibidas, 0), 3) AS unidades_recibidas
     FROM ordenes_compra oc
     INNER JOIN proveedores p ON p.id_proveedor = oc.id_proveedor
     LEFT JOIN ordenes_compra_detalle ocd ON ocd.id_oc = oc.id_oc
     LEFT JOIN productos pr ON pr.id_producto = ocd.id_producto
     LEFT JOIN (
       SELECT
           rc.id_oc,
           COUNT(DISTINCT rc.id_recepcion) AS recepciones,
           MAX(rc.fecha_hora) AS fecha_ultima_recepcion,
           SUM(COALESCE(rcd.cantidad_recibida, 0)) AS unidades_recibidas
       FROM recepciones_compra rc
       LEFT JOIN recepciones_compra_detalle rcd ON rcd.id_recepcion = rc.id_recepcion
       GROUP BY rc.id_oc
     ) rec ON rec.id_oc = oc.id_oc
     ${where}
     GROUP BY
        oc.id_oc,
        oc.numero_oc,
        oc.fecha,
        oc.estado,
        p.nombre,
        oc.subtotal,
        oc.impuestos,
        oc.total,
        rec.recepciones,
        rec.fecha_ultima_recepcion,
        rec.unidades_recibidas
     ORDER BY oc.fecha DESC, oc.id_oc DESC`,
    params
  );

  const details = await query(
    `SELECT
        oc.numero_oc,
        oc.fecha,
        p.nombre AS proveedor,
        pr.sku,
        pr.nombre_comercial,
        ocd.cantidad,
        ocd.precio_unitario,
        ocd.descuento,
        ocd.impuesto,
        ROUND((ocd.cantidad * ocd.precio_unitario) - ocd.descuento + ocd.impuesto, 2) AS total_linea,
        ocd.fecha_requerida
     FROM ordenes_compra_detalle ocd
     INNER JOIN ordenes_compra oc ON oc.id_oc = ocd.id_oc
     INNER JOIN proveedores p ON p.id_proveedor = oc.id_proveedor
     INNER JOIN productos pr ON pr.id_producto = ocd.id_producto
     ${where}
     ORDER BY oc.fecha DESC, oc.numero_oc DESC, pr.nombre_comercial ASC`,
    params
  );

  return { filter, orders, details };
}

function buildPurchasesReport(filter, orders, details) {
  const summary = {
    ordenes: orders.length,
    proveedores: new Set(orders.map((row) => row.proveedor)).size,
    total_monetario: Number(orders.reduce((sum, row) => sum + toNumber(row.total), 0).toFixed(2)),
    subtotal: Number(orders.reduce((sum, row) => sum + toNumber(row.subtotal), 0).toFixed(2)),
    impuestos: Number(orders.reduce((sum, row) => sum + toNumber(row.impuestos), 0).toFixed(2)),
    unidades_solicitadas: Number(orders.reduce((sum, row) => sum + toNumber(row.unidades_solicitadas), 0).toFixed(3)),
    unidades_recibidas: Number(orders.reduce((sum, row) => sum + toNumber(row.unidades_recibidas), 0).toFixed(3)),
    borrador: orders.filter((row) => row.estado === 'borrador').length,
    aprobada: orders.filter((row) => row.estado === 'aprobada').length,
    recibida_parcial: orders.filter((row) => row.estado === 'recibida_parcial').length,
    recibida_total: orders.filter((row) => row.estado === 'recibida_total').length,
    cancelada: orders.filter((row) => row.estado === 'cancelada').length
  };

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary,
    orders,
    details
  };
}

function purchaseSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'Órdenes', valor: data.summary.ordenes },
    { metrica: 'Proveedores involucrados', valor: data.summary.proveedores },
    { metrica: 'Subtotal acumulado', valor: data.summary.subtotal },
    { metrica: 'Impuestos acumulados', valor: data.summary.impuestos },
    { metrica: 'Total acumulado', valor: data.summary.total_monetario },
    { metrica: 'Unidades solicitadas', valor: data.summary.unidades_solicitadas },
    { metrica: 'Unidades recibidas', valor: data.summary.unidades_recibidas },
    { metrica: 'En borrador', valor: data.summary.borrador },
    { metrica: 'Aprobadas', valor: data.summary.aprobada },
    { metrica: 'Recibidas parciales', valor: data.summary.recibida_parcial },
    { metrica: 'Recibidas totales', valor: data.summary.recibida_total },
    { metrica: 'Canceladas', valor: data.summary.cancelada }
  ];
}

function buildPurchasesExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: purchaseSummaryRows(data)
    },
    {
      name: 'Ordenes',
      columns: [
        { key: 'numero_oc', label: 'OC', width: 90, type: 'string' },
        { key: 'fecha', label: 'Fecha', width: 90, type: 'string' },
        { key: 'proveedor', label: 'Proveedor', width: 180, type: 'string' },
        { key: 'estado', label: 'Estado', width: 110, type: 'string' },
        { key: 'lineas', label: 'Líneas', width: 70, type: 'number' },
        { key: 'unidades_solicitadas', label: 'Unid solicitadas', width: 110, type: 'number' },
        { key: 'unidades_recibidas', label: 'Unid recibidas', width: 110, type: 'number' },
        { key: 'recepciones', label: 'Recepciones', width: 90, type: 'number' },
        { key: 'total', label: 'Total', width: 90, type: 'number' }
      ],
      rows: data.orders
    },
    {
      name: 'Detalle',
      columns: [
        { key: 'numero_oc', label: 'OC', width: 90, type: 'string' },
        { key: 'proveedor', label: 'Proveedor', width: 180, type: 'string' },
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
        { key: 'precio_unitario', label: 'Precio unitario', width: 90, type: 'number' },
        { key: 'descuento', label: 'Descuento', width: 80, type: 'number' },
        { key: 'impuesto', label: 'Impuesto', width: 80, type: 'number' },
        { key: 'total_linea', label: 'Total línea', width: 90, type: 'number' },
        { key: 'fecha_requerida', label: 'Fecha requerida', width: 100, type: 'string' }
      ],
      rows: data.details
    }
  ]);
}

function buildPurchasesPdf(data) {
  const lines = [];
  lines.push(...purchaseSummaryRows(data).map((row) => `${pad(row.metrica, 30)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'ORDENES DE COMPRA');
  lines.push(...tableLines([
    { key: 'numero_oc', label: 'OC', width: 12 },
    { key: 'fecha', label: 'FECHA', width: 12 },
    { key: 'proveedor', label: 'PROVEEDOR', width: 24 },
    { key: 'estado', label: 'ESTADO', width: 15 },
    { key: 'unidades_solicitadas', label: 'SOL', width: 7, align: 'right' },
    { key: 'unidades_recibidas', label: 'REC', width: 7, align: 'right' },
    { key: 'total', label: 'TOTAL', width: 10, align: 'right' }
  ], data.orders));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE COMPRAS',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchSalesDataset(search = '') {
  const filter = String(search ?? '').trim();
  const like = `%${filter}%`;
  const where = filter
    ? `WHERE (
        v.folio_venta LIKE ? OR COALESCE(c.nombre, '') LIKE ? OR COALESCE(pa.nombre, '') LIKE ? OR v.estado LIKE ? OR pr.nombre_comercial LIKE ? OR pr.sku LIKE ?
      )`
    : '';
  const params = filter ? [like, like, like, like, like, like] : [];

  const sales = await query(
    `SELECT
        v.id_venta,
        v.folio_venta,
        v.fecha_hora,
        v.tipo,
        v.estado,
        COALESCE(c.nombre, 'Mostrador') AS cliente,
        COALESCE(pa.nombre, 'Sin paciente') AS paciente,
        COUNT(DISTINCT vd.id_venta_detalle) AS lineas,
        ROUND(COALESCE(SUM(vd.cantidad), 0), 3) AS unidades,
        ROUND(COALESCE(SUM(CASE WHEN pr.es_controlado = TRUE THEN vd.cantidad ELSE 0 END), 0), 3) AS unidades_controladas,
        v.metodo_pago,
        v.requiere_factura,
        v.subtotal,
        v.impuestos,
        v.total,
        f.numero_completo AS factura,
        f.estado AS estado_factura
     FROM ventas v
     LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
     LEFT JOIN pacientes pa ON pa.id_paciente = v.id_paciente
     LEFT JOIN ventas_detalle vd ON vd.id_venta = v.id_venta
     LEFT JOIN productos pr ON pr.id_producto = vd.id_producto
     LEFT JOIN facturas f ON f.id_venta = v.id_venta
     ${where}
     GROUP BY
        v.id_venta,
        v.folio_venta,
        v.fecha_hora,
        v.tipo,
        v.estado,
        c.nombre,
        pa.nombre,
        v.metodo_pago,
        v.requiere_factura,
        v.subtotal,
        v.impuestos,
        v.total,
        f.numero_completo,
        f.estado
     ORDER BY v.fecha_hora DESC, v.id_venta DESC`,
    params
  );

  const details = await query(
    `SELECT
        v.folio_venta,
        v.fecha_hora,
        COALESCE(c.nombre, 'Mostrador') AS cliente,
        pr.sku,
        pr.nombre_comercial,
        l.numero_lote,
        vd.cantidad,
        vd.precio_unitario,
        vd.impuesto,
        vd.descuento,
        ROUND((vd.cantidad * vd.precio_unitario) - vd.descuento + vd.impuesto, 2) AS total_linea,
        CASE WHEN pr.es_controlado = TRUE THEN 'si' ELSE 'no' END AS controlado,
        CASE WHEN pr.requiere_cadena_frio = TRUE THEN 'si' ELSE 'no' END AS cadena_frio
     FROM ventas_detalle vd
     INNER JOIN ventas v ON v.id_venta = vd.id_venta
     LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
     LEFT JOIN pacientes pa ON pa.id_paciente = v.id_paciente
     INNER JOIN productos pr ON pr.id_producto = vd.id_producto
     INNER JOIN lotes l ON l.id_lote = vd.id_lote
     ${where}
     ORDER BY v.fecha_hora DESC, v.folio_venta DESC, pr.nombre_comercial ASC`,
    params
  );

  return { filter, sales, details };
}

function buildSalesReport(filter, sales, details) {
  const summary = {
    ventas: sales.length,
    clientes: new Set(sales.map((row) => row.cliente)).size,
    total_monetario: Number(sales.reduce((sum, row) => sum + toNumber(row.total), 0).toFixed(2)),
    subtotal: Number(sales.reduce((sum, row) => sum + toNumber(row.subtotal), 0).toFixed(2)),
    impuestos: Number(sales.reduce((sum, row) => sum + toNumber(row.impuestos), 0).toFixed(2)),
    unidades: Number(sales.reduce((sum, row) => sum + toNumber(row.unidades), 0).toFixed(3)),
    unidades_controladas: Number(sales.reduce((sum, row) => sum + toNumber(row.unidades_controladas), 0).toFixed(3)),
    confirmadas: sales.filter((row) => row.estado === 'confirmada').length,
    facturadas: sales.filter((row) => row.estado === 'facturada').length,
    anuladas: sales.filter((row) => row.estado === 'anulada').length,
    requieren_factura: sales.filter((row) => Boolean(row.requiere_factura)).length,
    con_factura: sales.filter((row) => row.factura).length
  };

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary,
    sales,
    details
  };
}

function salesSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'Ventas', valor: data.summary.ventas },
    { metrica: 'Clientes involucrados', valor: data.summary.clientes },
    { metrica: 'Subtotal acumulado', valor: data.summary.subtotal },
    { metrica: 'Impuestos acumulados', valor: data.summary.impuestos },
    { metrica: 'Total acumulado', valor: data.summary.total_monetario },
    { metrica: 'Unidades vendidas', valor: data.summary.unidades },
    { metrica: 'Unidades controladas', valor: data.summary.unidades_controladas },
    { metrica: 'Confirmadas', valor: data.summary.confirmadas },
    { metrica: 'Facturadas', valor: data.summary.facturadas },
    { metrica: 'Anuladas', valor: data.summary.anuladas },
    { metrica: 'Requieren factura', valor: data.summary.requieren_factura },
    { metrica: 'Con factura emitida', valor: data.summary.con_factura }
  ];
}

function buildSalesExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: salesSummaryRows(data)
    },
    {
      name: 'Ventas',
      columns: [
        { key: 'folio_venta', label: 'Folio', width: 90, type: 'string' },
        { key: 'fecha_hora', label: 'Fecha', width: 120, type: 'string' },
        { key: 'cliente', label: 'Cliente', width: 180, type: 'string' },
        { key: 'paciente', label: 'Paciente', width: 180, type: 'string' },
        { key: 'estado', label: 'Estado', width: 90, type: 'string' },
        { key: 'unidades', label: 'Unidades', width: 80, type: 'number' },
        { key: 'unidades_controladas', label: 'Controladas', width: 90, type: 'number' },
        { key: 'metodo_pago', label: 'Pago', width: 90, type: 'string' },
        { key: 'requiere_factura', label: 'Req. factura', width: 90, type: 'string' },
        { key: 'factura', label: 'Factura', width: 110, type: 'string' },
        { key: 'estado_factura', label: 'Estado factura', width: 110, type: 'string' },
        { key: 'total', label: 'Total', width: 90, type: 'number' }
      ],
      rows: data.sales
    },
    {
      name: 'Detalle',
      columns: [
        { key: 'folio_venta', label: 'Folio', width: 90, type: 'string' },
        { key: 'cliente', label: 'Cliente', width: 160, type: 'string' },
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
        { key: 'precio_unitario', label: 'Precio unitario', width: 90, type: 'number' },
        { key: 'descuento', label: 'Descuento', width: 80, type: 'number' },
        { key: 'impuesto', label: 'Impuesto', width: 80, type: 'number' },
        { key: 'total_linea', label: 'Total línea', width: 90, type: 'number' },
        { key: 'controlado', label: 'Controlado', width: 80, type: 'string' },
        { key: 'cadena_frio', label: 'Cadena frío', width: 90, type: 'string' }
      ],
      rows: data.details
    }
  ]);
}

function buildSalesPdf(data) {
  const lines = [];
  lines.push(...salesSummaryRows(data).map((row) => `${pad(row.metrica, 28)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'VENTAS');
  lines.push(...tableLines([
    { key: 'folio_venta', label: 'FOLIO', width: 12 },
    { key: 'fecha_hora', label: 'FECHA', width: 18 },
    { key: 'cliente', label: 'CLIENTE', width: 22 },
    { key: 'estado', label: 'ESTADO', width: 12 },
    { key: 'unidades', label: 'UNID', width: 7, align: 'right' },
    { key: 'factura', label: 'FACTURA', width: 14 },
    { key: 'total', label: 'TOTAL', width: 10, align: 'right' }
  ], data.sales));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE VENTAS',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchExpirationsDataset(days = 180) {
  const horizonDays = normalizeBoundedInteger(days, 180, { min: 1, max: 1095 });
  const rows = await query(
    `SELECT
        p.id_producto,
        p.sku,
        p.nombre_comercial,
        p.codigo_barras,
        l.id_lote,
        l.numero_lote,
        l.fecha_vencimiento,
        DATEDIFF(l.fecha_vencimiento, CURRENT_DATE()) AS dias_para_vencer,
        a.nombre AS almacen,
        u.nombre AS ubicacion,
        ROUND(e.cantidad_disponible, 3) AS cantidad_disponible,
        ROUND(e.cantidad_reservada, 3) AS cantidad_reservada,
        ROUND(e.cantidad_cuarentena, 3) AS cantidad_cuarentena,
        ROUND(l.costo_unitario, 2) AS costo_unitario,
        ROUND(e.cantidad_disponible * l.costo_unitario, 2) AS valor_estimado,
        CASE
          WHEN DATEDIFF(l.fecha_vencimiento, CURRENT_DATE()) < 0 THEN 'vencido'
          WHEN DATEDIFF(l.fecha_vencimiento, CURRENT_DATE()) <= 30 THEN 'critico'
          WHEN DATEDIFF(l.fecha_vencimiento, CURRENT_DATE()) <= 90 THEN 'alerta'
          ELSE 'seguimiento'
        END AS severidad,
        CASE WHEN p.requiere_cadena_frio = TRUE THEN 'si' ELSE 'no' END AS cadena_frio,
        CASE WHEN p.es_controlado = TRUE THEN 'si' ELSE 'no' END AS controlado
     FROM existencias e
     INNER JOIN lotes l ON l.id_lote = e.id_lote
     INNER JOIN productos p ON p.id_producto = l.id_producto
     INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
     INNER JOIN ubicaciones_almacen u ON u.id_ubicacion = e.id_ubicacion
     WHERE (e.cantidad_disponible > 0 OR e.cantidad_cuarentena > 0)
       AND l.fecha_vencimiento <= DATE_ADD(CURRENT_DATE(), INTERVAL ? DAY)
     ORDER BY l.fecha_vencimiento ASC, e.cantidad_disponible DESC, p.nombre_comercial ASC`,
    [horizonDays]
  );

  return { horizonDays, rows };
}

function buildExpirationsReport(horizonDays, rows) {
  const summary = {
    registros: rows.length,
    productos: new Set(rows.map((row) => row.id_producto)).size,
    lotes: new Set(rows.map((row) => row.id_lote)).size,
    unidades: Number(rows.reduce((sum, row) => sum + toNumber(row.cantidad_disponible), 0).toFixed(3)),
    valor_estimado: Number(rows.reduce((sum, row) => sum + toNumber(row.valor_estimado), 0).toFixed(2)),
    vencidos: rows.filter((row) => row.severidad === 'vencido').length,
    criticos: rows.filter((row) => row.severidad === 'critico').length,
    alerta: rows.filter((row) => row.severidad === 'alerta').length,
    seguimiento: rows.filter((row) => row.severidad === 'seguimiento').length,
    cadena_frio: rows.filter((row) => row.cadena_frio === 'si').length,
    controlados: rows.filter((row) => row.controlado === 'si').length
  };

  return {
    generatedAt: new Date().toISOString(),
    horizonDays,
    summary,
    rows
  };
}

function expirationSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Horizonte evaluado (días)', valor: data.horizonDays },
    { metrica: 'Registros', valor: data.summary.registros },
    { metrica: 'Productos únicos', valor: data.summary.productos },
    { metrica: 'Lotes únicos', valor: data.summary.lotes },
    { metrica: 'Unidades impactadas', valor: data.summary.unidades },
    { metrica: 'Valor estimado', valor: data.summary.valor_estimado },
    { metrica: 'Lotes vencidos', valor: data.summary.vencidos },
    { metrica: 'Lotes críticos (<=30d)', valor: data.summary.criticos },
    { metrica: 'Lotes en alerta (31-90d)', valor: data.summary.alerta },
    { metrica: 'Seguimiento', valor: data.summary.seguimiento },
    { metrica: 'Productos de cadena de frío', valor: data.summary.cadena_frio },
    { metrica: 'Productos controlados', valor: data.summary.controlados }
  ];
}

function buildExpirationsExcel(data) {
  const prioritizedRows = data.rows.filter((row) => ['vencido', 'critico', 'alerta'].includes(row.severidad));
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 230, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: expirationSummaryRows(data)
    },
    {
      name: 'Lotes',
      columns: [
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
        { key: 'fecha_vencimiento', label: 'Vence', width: 90, type: 'string' },
        { key: 'dias_para_vencer', label: 'Días', width: 70, type: 'number' },
        { key: 'severidad', label: 'Severidad', width: 90, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 150, type: 'string' },
        { key: 'ubicacion', label: 'Ubicación', width: 140, type: 'string' },
        { key: 'cantidad_disponible', label: 'Disponible', width: 80, type: 'number' },
        { key: 'cantidad_cuarentena', label: 'Cuarentena', width: 90, type: 'number' },
        { key: 'valor_estimado', label: 'Valor estimado', width: 100, type: 'number' },
        { key: 'cadena_frio', label: 'Cadena frío', width: 90, type: 'string' },
        { key: 'controlado', label: 'Controlado', width: 90, type: 'string' }
      ],
      rows: data.rows
    },
    {
      name: 'Priorizados',
      columns: [
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
        { key: 'fecha_vencimiento', label: 'Vence', width: 90, type: 'string' },
        { key: 'dias_para_vencer', label: 'Días', width: 70, type: 'number' },
        { key: 'severidad', label: 'Severidad', width: 90, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 150, type: 'string' },
        { key: 'cantidad_disponible', label: 'Disponible', width: 80, type: 'number' }
      ],
      rows: prioritizedRows
    }
  ]);
}

function buildExpirationsPdf(data) {
  const prioritizedRows = data.rows.filter((row) => ['vencido', 'critico', 'alerta'].includes(row.severidad));
  const lines = [];
  lines.push(...expirationSummaryRows(data).map((row) => `${pad(row.metrica, 31)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'LOTES PRIORIZADOS POR VENCIMIENTO');
  lines.push(...tableLines([
    { key: 'numero_lote', label: 'LOTE', width: 14 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 28 },
    { key: 'fecha_vencimiento', label: 'VENCE', width: 12 },
    { key: 'dias_para_vencer', label: 'DIAS', width: 6, align: 'right' },
    { key: 'severidad', label: 'SEV', width: 11 },
    { key: 'cantidad_disponible', label: 'DISP', width: 8, align: 'right' }
  ], prioritizedRows));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE VENCIMIENTOS',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchColdChainDataset(hours = 72) {
  const periodHours = normalizeBoundedInteger(hours, 72, { min: 1, max: 24 * 180 });

  const equipmentStatus = await query(
    `SELECT
        eq.id_equipo,
        eq.codigo,
        eq.nombre AS equipo,
        alm.nombre AS almacen,
        eq.marca,
        eq.modelo,
        eq.temp_min,
        eq.temp_max,
        lc.fecha_hora AS ultima_lectura,
        lc.temperatura,
        lc.humedad,
        CASE
          WHEN lc.id_lectura IS NULL THEN 'sin_lectura'
          WHEN lc.temperatura BETWEEN eq.temp_min AND eq.temp_max THEN 'en_rango'
          ELSE 'fuera_rango'
        END AS estado_actual,
        CASE
          WHEN lc.fecha_hora IS NULL THEN NULL
          ELSE TIMESTAMPDIFF(MINUTE, lc.fecha_hora, NOW())
        END AS minutos_desde_lectura
     FROM equipos_cadena_frio eq
     INNER JOIN almacenes alm ON alm.id_almacen = eq.id_almacen
     LEFT JOIN lecturas_cadena_frio lc ON lc.id_lectura = (
       SELECT lc2.id_lectura
       FROM lecturas_cadena_frio lc2
       WHERE lc2.id_equipo = eq.id_equipo
       ORDER BY lc2.fecha_hora DESC
       LIMIT 1
     )
     WHERE eq.activo = TRUE
     ORDER BY eq.nombre ASC`
  );

  const readings = await query(
    `SELECT
        lc.fecha_hora,
        eq.codigo,
        eq.nombre AS equipo,
        alm.nombre AS almacen,
        lc.temperatura,
        lc.humedad,
        lc.fuente,
        lc.fuera_rango,
        eq.temp_min,
        eq.temp_max,
        CASE
          WHEN lc.temperatura BETWEEN eq.temp_min AND eq.temp_max THEN 'en_rango'
          ELSE 'fuera_rango'
        END AS estado_lectura
     FROM lecturas_cadena_frio lc
     INNER JOIN equipos_cadena_frio eq ON eq.id_equipo = lc.id_equipo
     INNER JOIN almacenes alm ON alm.id_almacen = eq.id_almacen
     WHERE lc.fecha_hora >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY lc.fecha_hora DESC
     LIMIT 500`,
    [periodHours]
  );

  const alerts = await query(
    `SELECT
        ac.id_alerta,
        ac.fecha_inicio,
        ac.fecha_fin,
        ac.severidad,
        ac.tipo,
        ac.descripcion,
        ac.estado,
        eq.codigo,
        eq.nombre AS equipo,
        alm.nombre AS almacen
     FROM alertas_cadena_frio ac
     INNER JOIN equipos_cadena_frio eq ON eq.id_equipo = ac.id_equipo
     INNER JOIN almacenes alm ON alm.id_almacen = eq.id_almacen
     WHERE ac.fecha_inicio >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        OR ac.estado IN ('abierta', 'en_proceso')
     ORDER BY ac.fecha_inicio DESC
     LIMIT 300`,
    [periodHours]
  );

  return { periodHours, equipmentStatus, readings, alerts };
}

function buildColdChainReport(periodHours, equipmentStatus, readings, alerts) {
  const summary = {
    periodo_horas: periodHours,
    equipos_activos: equipmentStatus.length,
    equipos_en_rango: equipmentStatus.filter((row) => row.estado_actual === 'en_rango').length,
    equipos_fuera_rango: equipmentStatus.filter((row) => row.estado_actual === 'fuera_rango').length,
    equipos_sin_lectura: equipmentStatus.filter((row) => row.estado_actual === 'sin_lectura').length,
    lecturas_periodo: readings.length,
    lecturas_fuera_rango: readings.filter((row) => row.estado_lectura === 'fuera_rango').length,
    alertas_abiertas: alerts.filter((row) => row.estado === 'abierta').length,
    alertas_en_proceso: alerts.filter((row) => row.estado === 'en_proceso').length,
    alertas_criticas: alerts.filter((row) => row.severidad === 'critica').length,
    temperatura_promedio: readings.length > 0
      ? Number((readings.reduce((sum, row) => sum + toNumber(row.temperatura), 0) / readings.length).toFixed(2))
      : 0
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    equipmentStatus,
    readings,
    alerts
  };
}

function coldChainSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Periodo evaluado (horas)', valor: data.summary.periodo_horas },
    { metrica: 'Equipos activos', valor: data.summary.equipos_activos },
    { metrica: 'Equipos en rango', valor: data.summary.equipos_en_rango },
    { metrica: 'Equipos fuera de rango', valor: data.summary.equipos_fuera_rango },
    { metrica: 'Equipos sin lectura', valor: data.summary.equipos_sin_lectura },
    { metrica: 'Lecturas en periodo', valor: data.summary.lecturas_periodo },
    { metrica: 'Lecturas fuera de rango', valor: data.summary.lecturas_fuera_rango },
    { metrica: 'Alertas abiertas', valor: data.summary.alertas_abiertas },
    { metrica: 'Alertas en proceso', valor: data.summary.alertas_en_proceso },
    { metrica: 'Alertas críticas', valor: data.summary.alertas_criticas },
    { metrica: 'Temperatura promedio', valor: data.summary.temperatura_promedio }
  ];
}

function buildColdChainExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: coldChainSummaryRows(data)
    },
    {
      name: 'Equipos',
      columns: [
        { key: 'codigo', label: 'Código', width: 90, type: 'string' },
        { key: 'equipo', label: 'Equipo', width: 180, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 150, type: 'string' },
        { key: 'temp_min', label: 'Temp min', width: 70, type: 'number' },
        { key: 'temp_max', label: 'Temp max', width: 70, type: 'number' },
        { key: 'temperatura', label: 'Última temp', width: 80, type: 'number' },
        { key: 'humedad', label: 'Humedad', width: 70, type: 'number' },
        { key: 'estado_actual', label: 'Estado', width: 100, type: 'string' },
        { key: 'ultima_lectura', label: 'Última lectura', width: 130, type: 'string' },
        { key: 'minutos_desde_lectura', label: 'Min. desde lectura', width: 100, type: 'number' }
      ],
      rows: data.equipmentStatus
    },
    {
      name: 'Lecturas',
      columns: [
        { key: 'fecha_hora', label: 'Fecha', width: 130, type: 'string' },
        { key: 'codigo', label: 'Código', width: 90, type: 'string' },
        { key: 'equipo', label: 'Equipo', width: 180, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 150, type: 'string' },
        { key: 'temperatura', label: 'Temp', width: 70, type: 'number' },
        { key: 'humedad', label: 'Humedad', width: 70, type: 'number' },
        { key: 'fuente', label: 'Fuente', width: 80, type: 'string' },
        { key: 'estado_lectura', label: 'Estado', width: 90, type: 'string' }
      ],
      rows: data.readings
    },
    {
      name: 'Alertas',
      columns: [
        { key: 'fecha_inicio', label: 'Inicio', width: 130, type: 'string' },
        { key: 'equipo', label: 'Equipo', width: 180, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 150, type: 'string' },
        { key: 'tipo', label: 'Tipo', width: 100, type: 'string' },
        { key: 'severidad', label: 'Severidad', width: 90, type: 'string' },
        { key: 'estado', label: 'Estado', width: 90, type: 'string' },
        { key: 'descripcion', label: 'Descripción', width: 260, type: 'string' }
      ],
      rows: data.alerts
    }
  ]);
}

function buildColdChainPdf(data) {
  const lines = [];
  lines.push(...coldChainSummaryRows(data).map((row) => `${pad(row.metrica, 28)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'ESTADO DE EQUIPOS');
  lines.push(...tableLines([
    { key: 'codigo', label: 'CODIGO', width: 10 },
    { key: 'equipo', label: 'EQUIPO', width: 22 },
    { key: 'almacen', label: 'ALMACEN', width: 16 },
    { key: 'temperatura', label: 'TEMP', width: 7, align: 'right' },
    { key: 'estado_actual', label: 'ESTADO', width: 12 },
    { key: 'minutos_desde_lectura', label: 'MIN', width: 6, align: 'right' }
  ], data.equipmentStatus));
  lines.push('', 'ALERTAS RELEVANTES');
  lines.push(...tableLines([
    { key: 'fecha_inicio', label: 'INICIO', width: 18 },
    { key: 'equipo', label: 'EQUIPO', width: 20 },
    { key: 'tipo', label: 'TIPO', width: 14 },
    { key: 'severidad', label: 'SEV', width: 10 },
    { key: 'estado', label: 'ESTADO', width: 12 }
  ], data.alerts));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE CADENA DE FRIO',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function finalizeExport({ normalizedFormat, fileBase, data, submodulo, descripcion, userId, excelBuilder, pdfBuilder }) {
  let buffer;
  let filename;

  if (normalizedFormat === 'json') {
    buffer = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    filename = `${fileBase}.json`;
  } else if (normalizedFormat === 'excel') {
    buffer = excelBuilder(data);
    filename = `${fileBase}.xls`;
  } else {
    buffer = pdfBuilder(data);
    filename = `${fileBase}.pdf`;
  }

  await writeAudit(pool, {
    idUsuario: userId,
    modulo: 'REPORTES',
    submodulo,
    accion: 'EXPORTACION',
    descripcion
  });

  return {
    filename,
    mimeType: MIME_TYPES[normalizedFormat],
    buffer
  };
}

export async function createDashboardExport(format, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const data = await getSummary();
  const fileBase = `akripharmacy-dashboard-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'DASHBOARD',
    descripcion: `Exportación de dashboard en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildDashboardExcel,
    pdfBuilder: buildDashboardPdf
  });
}

export async function createInventoryExport(format, search = '', userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const rows = await listStock(search);
  const data = buildInventoryReport(search, rows);
  const fileBase = `akripharmacy-inventario-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'INVENTARIO',
    descripcion: `Exportación de inventario en formato ${normalizedFormat}${search ? ` con filtro ${search}` : ''}`,
    userId,
    excelBuilder: buildInventoryExcel,
    pdfBuilder: buildInventoryPdf
  });
}

export async function createPurchasesExport(format, search = '', userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchPurchasesDataset(search);
  const data = buildPurchasesReport(dataset.filter, dataset.orders, dataset.details);
  const fileBase = `akripharmacy-compras-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'COMPRAS',
    descripcion: `Exportación de compras en formato ${normalizedFormat}${dataset.filter ? ` con filtro ${dataset.filter}` : ''}`,
    userId,
    excelBuilder: buildPurchasesExcel,
    pdfBuilder: buildPurchasesPdf
  });
}

export async function createSalesExport(format, search = '', userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchSalesDataset(search);
  const data = buildSalesReport(dataset.filter, dataset.sales, dataset.details);
  const fileBase = `akripharmacy-ventas-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'VENTAS',
    descripcion: `Exportación de ventas en formato ${normalizedFormat}${dataset.filter ? ` con filtro ${dataset.filter}` : ''}`,
    userId,
    excelBuilder: buildSalesExcel,
    pdfBuilder: buildSalesPdf
  });
}

export async function createExpirationsExport(format, days = 180, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchExpirationsDataset(days);
  const data = buildExpirationsReport(dataset.horizonDays, dataset.rows);
  const fileBase = `akripharmacy-vencimientos-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'VENCIMIENTOS',
    descripcion: `Exportación de vencimientos en formato ${normalizedFormat} con horizonte ${data.horizonDays} días`,
    userId,
    excelBuilder: buildExpirationsExcel,
    pdfBuilder: buildExpirationsPdf
  });
}

export async function createColdChainExport(format, hours = 72, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchColdChainDataset(hours);
  const data = buildColdChainReport(dataset.periodHours, dataset.equipmentStatus, dataset.readings, dataset.alerts);
  const fileBase = `akripharmacy-cadena-frio-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'CADENA_FRIO',
    descripcion: `Exportación de cadena de frío en formato ${normalizedFormat} con periodo ${data.summary.periodo_horas} horas`,
    userId,
    excelBuilder: buildColdChainExcel,
    pdfBuilder: buildColdChainPdf
  });
}


function sumBy(rows, key) {
  return rows.reduce((total, row) => total + toNumber(row?.[key]), 0);
}

function countWhere(rows, predicate) {
  return rows.reduce((total, row) => total + (predicate(row) ? 1 : 0), 0);
}

function normalizeBoolean(value) {
  return value === true || value === 1 || value === '1';
}

async function fetchSiesaBillingDataset(search = '') {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const invoices = await query(
    `SELECT
        f.id_factura,
        f.numero_completo,
        f.fecha_emision,
        f.estado,
        f.moneda,
        f.subtotal,
        f.impuestos,
        f.total,
        v.folio_venta,
        COALESCE(c.nombre, 'Mostrador') AS cliente,
        COUNT(DISTINCT fd.id_factura_detalle) AS lineas,
        COUNT(DISTINCT sl.id_log) AS total_logs,
        COALESCE(SUM(CASE WHEN sl.exito THEN 1 ELSE 0 END), 0) AS logs_exitosos,
        COALESCE(SUM(CASE WHEN sl.exito THEN 0 ELSE 1 END), 0) AS logs_error,
        MAX(sl.fecha_hora) AS ultima_interaccion_siesa,
        MAX(sl.estado_http) AS ultimo_estado_http
     FROM facturas f
     INNER JOIN ventas v ON v.id_venta = f.id_venta
     LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
     LEFT JOIN facturas_detalle fd ON fd.id_factura = f.id_factura
     LEFT JOIN integracion_siesa_logs sl ON sl.id_factura = f.id_factura
     WHERE (
       ? = ''
       OR f.numero_completo LIKE ?
       OR v.folio_venta LIKE ?
       OR COALESCE(c.nombre, '') LIKE ?
       OR f.estado LIKE ?
     )
     GROUP BY f.id_factura, f.numero_completo, f.fecha_emision, f.estado, f.moneda, f.subtotal, f.impuestos, f.total, v.folio_venta, cliente
     ORDER BY f.fecha_emision DESC, f.id_factura DESC`,
    [filter, wildcard, wildcard, wildcard, wildcard]
  );

  const details = await query(
    `SELECT
        f.numero_completo,
        v.folio_venta,
        COALESCE(c.nombre, 'Mostrador') AS cliente,
        p.sku,
        fd.descripcion,
        fd.cantidad,
        fd.precio_unitario,
        fd.impuesto,
        fd.total_linea
     FROM facturas_detalle fd
     INNER JOIN facturas f ON f.id_factura = fd.id_factura
     INNER JOIN ventas v ON v.id_venta = f.id_venta
     LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
     LEFT JOIN productos p ON p.id_producto = fd.id_producto
     WHERE (
       ? = ''
       OR f.numero_completo LIKE ?
       OR v.folio_venta LIKE ?
       OR COALESCE(c.nombre, '') LIKE ?
       OR fd.descripcion LIKE ?
       OR COALESCE(p.sku, '') LIKE ?
     )
     ORDER BY f.fecha_emision DESC, f.id_factura DESC, fd.id_factura_detalle ASC`,
    [filter, wildcard, wildcard, wildcard, wildcard, wildcard]
  );

  const logs = await query(
    `SELECT
        sl.id_log,
        sl.fecha_hora,
        COALESCE(f.numero_completo, 'SIN-FACTURA') AS numero_completo,
        COALESCE(v.folio_venta, 'SIN-VENTA') AS folio_venta,
        sl.endpoint,
        sl.metodo,
        sl.estado_http,
        sl.exito,
        COALESCE(sl.mensaje_error, '') AS mensaje_error
     FROM integracion_siesa_logs sl
     LEFT JOIN facturas f ON f.id_factura = sl.id_factura
     LEFT JOIN ventas v ON v.id_venta = f.id_venta
     LEFT JOIN clientes c ON c.id_cliente = v.id_cliente
     WHERE (
       ? = ''
       OR COALESCE(f.numero_completo, '') LIKE ?
       OR COALESCE(v.folio_venta, '') LIKE ?
       OR COALESCE(c.nombre, '') LIKE ?
       OR sl.endpoint LIKE ?
       OR COALESCE(sl.mensaje_error, '') LIKE ?
     )
     ORDER BY sl.fecha_hora DESC, sl.id_log DESC`,
    [filter, wildcard, wildcard, wildcard, wildcard, wildcard]
  );

  return { filter, invoices, details, logs };
}

function buildSiesaBillingReport(filter, invoices, details, logs) {
  const summary = {
    total_facturas: invoices.length,
    valor_total: sumBy(invoices, 'total'),
    facturas_aceptadas: countWhere(invoices, (row) => row.estado === 'aceptada'),
    facturas_rechazadas: countWhere(invoices, (row) => row.estado === 'rechazada'),
    facturas_pendientes: countWhere(invoices, (row) => ['borrador', 'emitida', 'enviada_siesa'].includes(row.estado)),
    logs_integracion: logs.length,
    logs_exitosos: countWhere(logs, (row) => normalizeBoolean(row.exito)),
    logs_error: countWhere(logs, (row) => !normalizeBoolean(row.exito))
  };

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary,
    invoices,
    details,
    logs
  };
}

function siesaBillingSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Todos' },
    { metrica: 'Facturas', valor: data.summary.total_facturas },
    { metrica: 'Valor total', valor: data.summary.valor_total },
    { metrica: 'Aceptadas', valor: data.summary.facturas_aceptadas },
    { metrica: 'Rechazadas', valor: data.summary.facturas_rechazadas },
    { metrica: 'Pendientes o emitidas', valor: data.summary.facturas_pendientes },
    { metrica: 'Logs de integración', valor: data.summary.logs_integracion },
    { metrica: 'Logs exitosos', valor: data.summary.logs_exitosos },
    { metrica: 'Logs con error', valor: data.summary.logs_error }
  ];
}

function buildSiesaBillingExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 140, type: 'string' }
      ],
      rows: siesaBillingSummaryRows(data)
    },
    {
      name: 'Facturas',
      columns: [
        { key: 'numero_completo', label: 'Factura', width: 120, type: 'string' },
        { key: 'fecha_emision', label: 'Fecha emisión', width: 130, type: 'string' },
        { key: 'folio_venta', label: 'Venta', width: 100, type: 'string' },
        { key: 'cliente', label: 'Cliente', width: 180, type: 'string' },
        { key: 'estado', label: 'Estado', width: 110, type: 'string' },
        { key: 'moneda', label: 'Moneda', width: 70, type: 'string' },
        { key: 'subtotal', label: 'Subtotal', width: 90, type: 'number' },
        { key: 'impuestos', label: 'Impuestos', width: 90, type: 'number' },
        { key: 'total', label: 'Total', width: 100, type: 'number' },
        { key: 'lineas', label: 'Líneas', width: 70, type: 'number' },
        { key: 'total_logs', label: 'Logs', width: 70, type: 'number' },
        { key: 'ultima_interaccion_siesa', label: 'Última interacción', width: 140, type: 'string' },
        { key: 'ultimo_estado_http', label: 'HTTP', width: 60, type: 'number' }
      ],
      rows: data.invoices
    },
    {
      name: 'Detalle',
      columns: [
        { key: 'numero_completo', label: 'Factura', width: 120, type: 'string' },
        { key: 'folio_venta', label: 'Venta', width: 100, type: 'string' },
        { key: 'cliente', label: 'Cliente', width: 180, type: 'string' },
        { key: 'sku', label: 'SKU', width: 100, type: 'string' },
        { key: 'descripcion', label: 'Descripción', width: 220, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
        { key: 'precio_unitario', label: 'Precio unitario', width: 90, type: 'number' },
        { key: 'impuesto', label: 'Impuesto', width: 80, type: 'number' },
        { key: 'total_linea', label: 'Total línea', width: 90, type: 'number' }
      ],
      rows: data.details
    },
    {
      name: 'IntegracionSIESA',
      columns: [
        { key: 'fecha_hora', label: 'Fecha', width: 140, type: 'string' },
        { key: 'numero_completo', label: 'Factura', width: 120, type: 'string' },
        { key: 'folio_venta', label: 'Venta', width: 100, type: 'string' },
        { key: 'endpoint', label: 'Endpoint', width: 180, type: 'string' },
        { key: 'metodo', label: 'Método', width: 70, type: 'string' },
        { key: 'estado_http', label: 'HTTP', width: 60, type: 'number' },
        { key: 'exito', label: 'Éxito', width: 60, type: 'string' },
        { key: 'mensaje_error', label: 'Mensaje error', width: 240, type: 'string' }
      ],
      rows: data.logs.map((row) => ({
        ...row,
        exito: normalizeBoolean(row.exito) ? 'Sí' : 'No'
      }))
    }
  ]);
}

function buildSiesaBillingPdf(data) {
  const lines = [];
  lines.push(...siesaBillingSummaryRows(data).map((row) => `${pad(row.metrica, 28)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'FACTURAS');
  lines.push(...tableLines([
    { key: 'numero_completo', label: 'FACTURA', width: 14 },
    { key: 'folio_venta', label: 'VENTA', width: 11 },
    { key: 'cliente', label: 'CLIENTE', width: 22 },
    { key: 'estado', label: 'ESTADO', width: 12 },
    { key: 'total', label: 'TOTAL', width: 11, align: 'right' }
  ], data.invoices));
  lines.push('', 'BITACORA SIESA');
  lines.push(...tableLines([
    { key: 'fecha_hora', label: 'FECHA', width: 18 },
    { key: 'numero_completo', label: 'FACTURA', width: 14 },
    { key: 'estado_http', label: 'HTTP', width: 6, align: 'right' },
    { key: 'exito', label: 'OK', width: 4 },
    { key: 'mensaje_error', label: 'MENSAJE', width: 32 }
  ], data.logs.map((row) => ({ ...row, exito: normalizeBoolean(row.exito) ? 'SI' : 'NO' }))));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE FACTURACION SIESA',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchControlledDataset(search = '', days = 365) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;
  const horizonDays = normalizeBoundedInteger(days, 365, { min: 1, max: 3650 });

  const movements = await query(
    `SELECT
        cl.fecha_hora,
        cl.tipo_movimiento,
        p.sku,
        p.nombre_comercial,
        l.numero_lote,
        cl.cantidad,
        cl.saldo_anterior,
        cl.saldo_nuevo,
        COALESCE(cl.receta_folio, '') AS receta_folio,
        COALESCE(cl.referencia_tipo, '') AS referencia_tipo,
        COALESCE(cl.referencia_id, '') AS referencia_id,
        CONCAT_WS(' ', u.nombre, u.apellido_paterno, u.apellido_materno) AS usuario_responsable,
        COALESCE(cl.observaciones, '') AS observaciones
     FROM controlados_libro cl
     INNER JOIN productos p ON p.id_producto = cl.id_producto
     INNER JOIN lotes l ON l.id_lote = cl.id_lote
     LEFT JOIN usuarios u ON u.id_usuario = cl.usuario_responsable
     WHERE cl.fecha_hora >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND (
         ? = ''
         OR p.nombre_comercial LIKE ?
         OR p.sku LIKE ?
         OR l.numero_lote LIKE ?
         OR COALESCE(cl.receta_folio, '') LIKE ?
         OR COALESCE(cl.referencia_tipo, '') LIKE ?
         OR COALESCE(cl.observaciones, '') LIKE ?
       )
     ORDER BY cl.fecha_hora DESC, cl.id_libro DESC`,
    [horizonDays, filter, wildcard, wildcard, wildcard, wildcard, wildcard, wildcard]
  );

  const stock = await query(
    `SELECT
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS stock_actual,
        ROUND(COALESCE(SUM(e.cantidad_cuarentena), 0), 3) AS stock_cuarentena,
        p.stock_minimo,
        COUNT(DISTINCT l.id_lote) AS lotes,
        MIN(l.fecha_vencimiento) AS proximo_vencimiento
     FROM productos p
     LEFT JOIN lotes l ON l.id_producto = p.id_producto
     LEFT JOIN existencias e ON e.id_lote = l.id_lote
     WHERE (p.es_controlado = TRUE OR p.tipo_producto = 'controlado')
       AND (
         ? = ''
         OR p.nombre_comercial LIKE ?
         OR p.sku LIKE ?
         OR COALESCE(p.codigo_barras, '') LIKE ?
       )
     GROUP BY p.id_producto, p.sku, p.codigo_barras, p.nombre_comercial, p.stock_minimo
     ORDER BY p.nombre_comercial ASC`,
    [filter, wildcard, wildcard, wildcard]
  );

  return { filter, horizonDays, movements, stock };
}

function buildControlledReport(filter, horizonDays, movements, stock) {
  const summary = {
    periodo_dias: horizonDays,
    registros_libro: movements.length,
    entradas: countWhere(movements, (row) => row.tipo_movimiento === 'entrada'),
    salidas: countWhere(movements, (row) => row.tipo_movimiento === 'salida'),
    ajustes: countWhere(movements, (row) => row.tipo_movimiento === 'ajuste'),
    cantidad_entradas: movements.filter((row) => row.tipo_movimiento === 'entrada').reduce((acc, row) => acc + toNumber(row.cantidad), 0),
    cantidad_salidas: movements.filter((row) => row.tipo_movimiento === 'salida').reduce((acc, row) => acc + toNumber(row.cantidad), 0),
    productos_controlados: stock.length,
    stock_actual_controlados: sumBy(stock, 'stock_actual'),
    productos_bajo_minimo: countWhere(stock, (row) => toNumber(row.stock_actual) <= toNumber(row.stock_minimo))
  };

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary,
    movements,
    stock
  };
}

function controlledSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Todos' },
    { metrica: 'Periodo (días)', valor: data.summary.periodo_dias },
    { metrica: 'Registros en libro', valor: data.summary.registros_libro },
    { metrica: 'Entradas', valor: data.summary.entradas },
    { metrica: 'Salidas', valor: data.summary.salidas },
    { metrica: 'Ajustes', valor: data.summary.ajustes },
    { metrica: 'Cantidad entradas', valor: data.summary.cantidad_entradas },
    { metrica: 'Cantidad salidas', valor: data.summary.cantidad_salidas },
    { metrica: 'Productos controlados', valor: data.summary.productos_controlados },
    { metrica: 'Stock actual controlados', valor: data.summary.stock_actual_controlados },
    { metrica: 'Productos bajo mínimo', valor: data.summary.productos_bajo_minimo }
  ];
}

function buildControlledExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 140, type: 'string' }
      ],
      rows: controlledSummaryRows(data)
    },
    {
      name: 'LibroControlados',
      columns: [
        { key: 'fecha_hora', label: 'Fecha', width: 140, type: 'string' },
        { key: 'tipo_movimiento', label: 'Movimiento', width: 100, type: 'string' },
        { key: 'sku', label: 'SKU', width: 100, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 200, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
        { key: 'saldo_anterior', label: 'Saldo anterior', width: 90, type: 'number' },
        { key: 'saldo_nuevo', label: 'Saldo nuevo', width: 90, type: 'number' },
        { key: 'receta_folio', label: 'Receta', width: 100, type: 'string' },
        { key: 'referencia_tipo', label: 'Ref. tipo', width: 90, type: 'string' },
        { key: 'referencia_id', label: 'Ref. id', width: 80, type: 'string' },
        { key: 'usuario_responsable', label: 'Usuario', width: 150, type: 'string' },
        { key: 'observaciones', label: 'Observaciones', width: 220, type: 'string' }
      ],
      rows: data.movements
    },
    {
      name: 'StockControlados',
      columns: [
        { key: 'sku', label: 'SKU', width: 100, type: 'string' },
        { key: 'codigo_barras', label: 'Código barras', width: 110, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 200, type: 'string' },
        { key: 'stock_actual', label: 'Stock actual', width: 90, type: 'number' },
        { key: 'stock_cuarentena', label: 'Cuarentena', width: 90, type: 'number' },
        { key: 'stock_minimo', label: 'Stock mínimo', width: 90, type: 'number' },
        { key: 'lotes', label: 'Lotes', width: 60, type: 'number' },
        { key: 'proximo_vencimiento', label: 'Próximo vencimiento', width: 130, type: 'string' }
      ],
      rows: data.stock
    }
  ]);
}

function buildControlledPdf(data) {
  const lines = [];
  lines.push(...controlledSummaryRows(data).map((row) => `${pad(row.metrica, 28)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'LIBRO DE CONTROLADOS');
  lines.push(...tableLines([
    { key: 'fecha_hora', label: 'FECHA', width: 18 },
    { key: 'tipo_movimiento', label: 'MOV', width: 10 },
    { key: 'sku', label: 'SKU', width: 12 },
    { key: 'numero_lote', label: 'LOTE', width: 12 },
    { key: 'cantidad', label: 'CANT', width: 8, align: 'right' },
    { key: 'receta_folio', label: 'RECETA', width: 12 }
  ], data.movements));
  lines.push('', 'STOCK ACTUAL CONTROLADOS');
  lines.push(...tableLines([
    { key: 'sku', label: 'SKU', width: 12 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 26 },
    { key: 'stock_actual', label: 'STOCK', width: 9, align: 'right' },
    { key: 'stock_minimo', label: 'MIN', width: 7, align: 'right' },
    { key: 'proximo_vencimiento', label: 'VENCE', width: 12 }
  ], data.stock));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE CONTROLADOS',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchBarcodeTraceDataset(search = '', days = 30) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;
  const horizonDays = normalizeBoundedInteger(days, 30, { min: 1, max: 3650 });

  const scans = await query(
    `SELECT
        s.fecha_hora,
        s.modo,
        s.fuente,
        s.codigo_barras,
        COALESCE(p.sku, '') AS sku,
        COALESCE(p.nombre_comercial, '') AS nombre_comercial,
        COALESCE(l.numero_lote, '') AS numero_lote,
        s.resultado,
        s.cantidad,
        COALESCE(s.mensaje, '') AS mensaje,
        CONCAT_WS(' ', u.nombre, u.apellido_paterno, u.apellido_materno) AS usuario
     FROM escaneos_codigo_barras s
     LEFT JOIN productos p ON p.id_producto = s.id_producto
     LEFT JOIN lotes l ON l.id_lote = s.id_lote
     LEFT JOIN usuarios u ON u.id_usuario = s.id_usuario
     WHERE s.fecha_hora >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND (
         ? = ''
         OR s.codigo_barras LIKE ?
         OR COALESCE(p.nombre_comercial, '') LIKE ?
         OR COALESCE(p.sku, '') LIKE ?
         OR COALESCE(l.numero_lote, '') LIKE ?
         OR COALESCE(s.mensaje, '') LIKE ?
       )
     ORDER BY s.fecha_hora DESC, s.id_escaneo DESC`,
    [horizonDays, filter, wildcard, wildcard, wildcard, wildcard, wildcard]
  );

  const topCodes = await query(
    `SELECT
        s.codigo_barras,
        COALESCE(MAX(p.sku), '') AS sku,
        COALESCE(MAX(p.nombre_comercial), '') AS nombre_comercial,
        COUNT(*) AS total_escaneos,
        SUM(CASE WHEN s.resultado = 'resuelto' THEN 1 ELSE 0 END) AS resueltos,
        SUM(CASE WHEN s.modo = 'ingreso' THEN 1 ELSE 0 END) AS ingresos,
        SUM(CASE WHEN s.modo = 'egreso' THEN 1 ELSE 0 END) AS egresos,
        SUM(CASE WHEN s.modo = 'consulta' THEN 1 ELSE 0 END) AS consultas,
        MAX(s.fecha_hora) AS ultimo_escaneo
     FROM escaneos_codigo_barras s
     LEFT JOIN productos p ON p.id_producto = s.id_producto
     LEFT JOIN lotes l ON l.id_lote = s.id_lote
     WHERE s.fecha_hora >= DATE_SUB(NOW(), INTERVAL ? DAY)
       AND (
         ? = ''
         OR s.codigo_barras LIKE ?
         OR COALESCE(p.nombre_comercial, '') LIKE ?
         OR COALESCE(p.sku, '') LIKE ?
         OR COALESCE(l.numero_lote, '') LIKE ?
         OR COALESCE(s.mensaje, '') LIKE ?
       )
     GROUP BY s.codigo_barras
     ORDER BY total_escaneos DESC, ultimo_escaneo DESC`,
    [horizonDays, filter, wildcard, wildcard, wildcard, wildcard, wildcard]
  );

  return { filter, horizonDays, scans, topCodes };
}

function buildBarcodeTraceReport(filter, horizonDays, scans, topCodes) {
  const summary = {
    periodo_dias: horizonDays,
    total_escaneos: scans.length,
    resueltos: countWhere(scans, (row) => row.resultado === 'resuelto'),
    no_encontrados: countWhere(scans, (row) => row.resultado === 'no_encontrado'),
    con_error: countWhere(scans, (row) => row.resultado === 'error'),
    ingresos: countWhere(scans, (row) => row.modo === 'ingreso'),
    egresos: countWhere(scans, (row) => row.modo === 'egreso'),
    consultas: countWhere(scans, (row) => row.modo === 'consulta'),
    codigos_distintos: new Set(scans.map((row) => row.codigo_barras)).size
  };

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary,
    scans,
    topCodes
  };
}

function barcodeTraceSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Todos' },
    { metrica: 'Periodo (días)', valor: data.summary.periodo_dias },
    { metrica: 'Total escaneos', valor: data.summary.total_escaneos },
    { metrica: 'Resueltos', valor: data.summary.resueltos },
    { metrica: 'No encontrados', valor: data.summary.no_encontrados },
    { metrica: 'Con error', valor: data.summary.con_error },
    { metrica: 'Ingresos', valor: data.summary.ingresos },
    { metrica: 'Egresos', valor: data.summary.egresos },
    { metrica: 'Consultas', valor: data.summary.consultas },
    { metrica: 'Códigos distintos', valor: data.summary.codigos_distintos }
  ];
}

function buildBarcodeTraceExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 140, type: 'string' }
      ],
      rows: barcodeTraceSummaryRows(data)
    },
    {
      name: 'Escaneos',
      columns: [
        { key: 'fecha_hora', label: 'Fecha', width: 140, type: 'string' },
        { key: 'modo', label: 'Modo', width: 90, type: 'string' },
        { key: 'fuente', label: 'Fuente', width: 90, type: 'string' },
        { key: 'codigo_barras', label: 'Código', width: 120, type: 'string' },
        { key: 'sku', label: 'SKU', width: 100, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 200, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
        { key: 'resultado', label: 'Resultado', width: 100, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
        { key: 'usuario', label: 'Usuario', width: 150, type: 'string' },
        { key: 'mensaje', label: 'Mensaje', width: 220, type: 'string' }
      ],
      rows: data.scans
    },
    {
      name: 'CodigosFrecuentes',
      columns: [
        { key: 'codigo_barras', label: 'Código', width: 120, type: 'string' },
        { key: 'sku', label: 'SKU', width: 100, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 200, type: 'string' },
        { key: 'total_escaneos', label: 'Escaneos', width: 80, type: 'number' },
        { key: 'resueltos', label: 'Resueltos', width: 80, type: 'number' },
        { key: 'ingresos', label: 'Ingresos', width: 80, type: 'number' },
        { key: 'egresos', label: 'Egresos', width: 80, type: 'number' },
        { key: 'consultas', label: 'Consultas', width: 80, type: 'number' },
        { key: 'ultimo_escaneo', label: 'Último escaneo', width: 140, type: 'string' }
      ],
      rows: data.topCodes
    }
  ]);
}

function buildBarcodeTracePdf(data) {
  const lines = [];
  lines.push(...barcodeTraceSummaryRows(data).map((row) => `${pad(row.metrica, 26)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'ESCANEOS RECIENTES');
  lines.push(...tableLines([
    { key: 'fecha_hora', label: 'FECHA', width: 18 },
    { key: 'modo', label: 'MODO', width: 9 },
    { key: 'fuente', label: 'FUENTE', width: 9 },
    { key: 'codigo_barras', label: 'CODIGO', width: 14 },
    { key: 'resultado', label: 'RES', width: 12 },
    { key: 'cantidad', label: 'CANT', width: 6, align: 'right' }
  ], data.scans));
  lines.push('', 'CODIGOS MAS USADOS');
  lines.push(...tableLines([
    { key: 'codigo_barras', label: 'CODIGO', width: 14 },
    { key: 'sku', label: 'SKU', width: 12 },
    { key: 'total_escaneos', label: 'TOT', width: 5, align: 'right' },
    { key: 'resueltos', label: 'OK', width: 5, align: 'right' },
    { key: 'ultimo_escaneo', label: 'ULTIMO', width: 18 }
  ], data.topCodes));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - TRAZABILIDAD DE ESCANEOS',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchProductImagesDataset(search = '') {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const products = await query(
    `SELECT
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        p.tipo_producto,
        p.es_controlado,
        p.requiere_cadena_frio,
        COUNT(pi.id_imagen) AS total_imagenes,
        SUM(CASE WHEN pi.tipo_origen = 'importada' THEN 1 ELSE 0 END) AS importadas,
        SUM(CASE WHEN pi.tipo_origen = 'escaneada' THEN 1 ELSE 0 END) AS escaneadas,
        SUM(CASE WHEN pi.tipo_origen = 'fotografia' THEN 1 ELSE 0 END) AS fotografias,
        MAX(CASE WHEN pi.es_principal THEN 1 ELSE 0 END) AS tiene_principal,
        MAX(pi.fecha_creacion) AS ultima_imagen
     FROM productos p
     LEFT JOIN productos_imagenes pi ON pi.id_producto = p.id_producto
     WHERE (
       ? = ''
       OR p.nombre_comercial LIKE ?
       OR p.sku LIKE ?
       OR COALESCE(p.codigo_barras, '') LIKE ?
       OR COALESCE(pi.tipo_origen, '') LIKE ?
     )
     GROUP BY p.id_producto, p.sku, p.codigo_barras, p.nombre_comercial, p.tipo_producto, p.es_controlado, p.requiere_cadena_frio
     ORDER BY p.nombre_comercial ASC`,
    [filter, wildcard, wildcard, wildcard, wildcard]
  );

  const images = await query(
    `SELECT
        pi.fecha_creacion,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        pi.tipo_origen,
        pi.nombre_archivo,
        pi.mime_type,
        pi.tamano_bytes,
        pi.es_principal,
        COALESCE(pi.descripcion, '') AS descripcion,
        CONCAT(?, '/', pi.url_relativa) AS url,
        CONCAT_WS(' ', u.nombre, u.apellido_paterno, u.apellido_materno) AS usuario
     FROM productos_imagenes pi
     INNER JOIN productos p ON p.id_producto = pi.id_producto
     LEFT JOIN usuarios u ON u.id_usuario = pi.id_usuario
     WHERE (
       ? = ''
       OR p.nombre_comercial LIKE ?
       OR p.sku LIKE ?
       OR COALESCE(p.codigo_barras, '') LIKE ?
       OR pi.tipo_origen LIKE ?
     )
     ORDER BY pi.fecha_creacion DESC, pi.id_imagen DESC`,
    [env.PUBLIC_UPLOAD_BASE_URL, filter, wildcard, wildcard, wildcard, wildcard]
  );

  return { filter, products, images };
}

function buildProductImagesReport(filter, products, images) {
  const summary = {
    productos_catalogo: products.length,
    productos_con_imagenes: countWhere(products, (row) => toNumber(row.total_imagenes) > 0),
    productos_sin_imagenes: countWhere(products, (row) => toNumber(row.total_imagenes) === 0),
    productos_sin_principal: countWhere(products, (row) => toNumber(row.total_imagenes) > 0 && !normalizeBoolean(row.tiene_principal)),
    imagenes_totales: images.length,
    imagenes_importadas: countWhere(images, (row) => row.tipo_origen === 'importada'),
    imagenes_escaneadas: countWhere(images, (row) => row.tipo_origen === 'escaneada'),
    imagenes_fotografia: countWhere(images, (row) => row.tipo_origen === 'fotografia')
  };

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary,
    products,
    images
  };
}

function productImagesSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Todos' },
    { metrica: 'Productos en catálogo', valor: data.summary.productos_catalogo },
    { metrica: 'Productos con imágenes', valor: data.summary.productos_con_imagenes },
    { metrica: 'Productos sin imágenes', valor: data.summary.productos_sin_imagenes },
    { metrica: 'Productos sin imagen principal', valor: data.summary.productos_sin_principal },
    { metrica: 'Imágenes totales', valor: data.summary.imagenes_totales },
    { metrica: 'Imágenes importadas', valor: data.summary.imagenes_importadas },
    { metrica: 'Imágenes escaneadas', valor: data.summary.imagenes_escaneadas },
    { metrica: 'Imágenes por fotografía', valor: data.summary.imagenes_fotografia }
  ];
}

function buildProductImagesExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 140, type: 'string' }
      ],
      rows: productImagesSummaryRows(data)
    },
    {
      name: 'CoberturaProducto',
      columns: [
        { key: 'sku', label: 'SKU', width: 100, type: 'string' },
        { key: 'codigo_barras', label: 'Código barras', width: 110, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'tipo_producto', label: 'Tipo', width: 90, type: 'string' },
        { key: 'total_imagenes', label: 'Imágenes', width: 80, type: 'number' },
        { key: 'importadas', label: 'Importadas', width: 80, type: 'number' },
        { key: 'escaneadas', label: 'Escaneadas', width: 80, type: 'number' },
        { key: 'fotografias', label: 'Fotografías', width: 80, type: 'number' },
        { key: 'tiene_principal', label: 'Principal', width: 70, type: 'string' },
        { key: 'ultima_imagen', label: 'Última imagen', width: 140, type: 'string' }
      ],
      rows: data.products.map((row) => ({
        ...row,
        tiene_principal: normalizeBoolean(row.tiene_principal) ? 'Sí' : 'No'
      }))
    },
    {
      name: 'Imagenes',
      columns: [
        { key: 'fecha_creacion', label: 'Fecha', width: 140, type: 'string' },
        { key: 'sku', label: 'SKU', width: 100, type: 'string' },
        { key: 'codigo_barras', label: 'Código barras', width: 110, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'tipo_origen', label: 'Origen', width: 90, type: 'string' },
        { key: 'nombre_archivo', label: 'Archivo', width: 180, type: 'string' },
        { key: 'mime_type', label: 'Mime', width: 120, type: 'string' },
        { key: 'tamano_bytes', label: 'Bytes', width: 90, type: 'number' },
        { key: 'es_principal', label: 'Principal', width: 70, type: 'string' },
        { key: 'usuario', label: 'Usuario', width: 150, type: 'string' },
        { key: 'descripcion', label: 'Descripción', width: 220, type: 'string' },
        { key: 'url', label: 'URL', width: 260, type: 'string' }
      ],
      rows: data.images.map((row) => ({
        ...row,
        es_principal: normalizeBoolean(row.es_principal) ? 'Sí' : 'No'
      }))
    }
  ]);
}

function buildProductImagesPdf(data) {
  const lines = [];
  lines.push(...productImagesSummaryRows(data).map((row) => `${pad(row.metrica, 30)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'COBERTURA POR PRODUCTO');
  lines.push(...tableLines([
    { key: 'sku', label: 'SKU', width: 12 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 26 },
    { key: 'total_imagenes', label: 'IMG', width: 5, align: 'right' },
    { key: 'tiene_principal', label: 'PRI', width: 4 },
    { key: 'ultima_imagen', label: 'ULTIMA', width: 18 }
  ], data.products.map((row) => ({ ...row, tiene_principal: normalizeBoolean(row.tiene_principal) ? 'SI' : 'NO' }))));
  lines.push('', 'IMAGENES REGISTRADAS');
  lines.push(...tableLines([
    { key: 'fecha_creacion', label: 'FECHA', width: 18 },
    { key: 'sku', label: 'SKU', width: 12 },
    { key: 'tipo_origen', label: 'ORIGEN', width: 11 },
    { key: 'es_principal', label: 'PRI', width: 4 },
    { key: 'nombre_archivo', label: 'ARCHIVO', width: 24 }
  ], data.images.map((row) => ({ ...row, es_principal: normalizeBoolean(row.es_principal) ? 'SI' : 'NO' }))));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE IMAGENES POR PRODUCTO',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

export async function createSiesaBillingExport(format, search = '', userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchSiesaBillingDataset(search);
  const data = buildSiesaBillingReport(dataset.filter, dataset.invoices, dataset.details, dataset.logs);
  const fileBase = `akripharmacy-siesa-facturacion-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'SIESA_FACTURACION',
    descripcion: `Exportación de facturación SIESA en formato ${normalizedFormat}${dataset.filter ? ` con filtro ${dataset.filter}` : ''}`,
    userId,
    excelBuilder: buildSiesaBillingExcel,
    pdfBuilder: buildSiesaBillingPdf
  });
}

export async function createControlledExport(format, search = '', days = 365, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchControlledDataset(search, days);
  const data = buildControlledReport(dataset.filter, dataset.horizonDays, dataset.movements, dataset.stock);
  const fileBase = `akripharmacy-controlados-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'CONTROLADOS',
    descripcion: `Exportación de controlados en formato ${normalizedFormat} con periodo ${data.summary.periodo_dias} días${dataset.filter ? ` y filtro ${dataset.filter}` : ''}`,
    userId,
    excelBuilder: buildControlledExcel,
    pdfBuilder: buildControlledPdf
  });
}

export async function createBarcodeTraceExport(format, search = '', days = 30, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchBarcodeTraceDataset(search, days);
  const data = buildBarcodeTraceReport(dataset.filter, dataset.horizonDays, dataset.scans, dataset.topCodes);
  const fileBase = `akripharmacy-trazabilidad-escaneos-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'TRAZABILIDAD_ESCANEOS',
    descripcion: `Exportación de trazabilidad de escaneos en formato ${normalizedFormat} con periodo ${data.summary.periodo_dias} días${dataset.filter ? ` y filtro ${dataset.filter}` : ''}`,
    userId,
    excelBuilder: buildBarcodeTraceExcel,
    pdfBuilder: buildBarcodeTracePdf
  });
}

export async function createProductImagesExport(format, search = '', userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchProductImagesDataset(search);
  const data = buildProductImagesReport(dataset.filter, dataset.products, dataset.images);
  const fileBase = `akripharmacy-imagenes-producto-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'IMAGENES_PRODUCTO',
    descripcion: `Exportación de imágenes por producto en formato ${normalizedFormat}${dataset.filter ? ` con filtro ${dataset.filter}` : ''}`,
    userId,
    excelBuilder: buildProductImagesExcel,
    pdfBuilder: buildProductImagesPdf
  });
}


async function fetchDispensingDataset(search = '') {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const headers = await query(
    `SELECT
        d.id_dispensacion,
        d.consecutivo,
        d.fecha_hora,
        d.receptor_tipo,
        d.receptor_nombre,
        d.firma_tipo,
        d.firma_nombre,
        d.estado,
        s.nombre AS sede,
        a.nombre AS almacen,
        p.nombre AS paciente,
        p.documento AS paciente_documento,
        p.direccion AS paciente_direccion,
        p.telefono AS paciente_telefono,
        dom.nombre AS domiciliario_nombre,
        dom.apellido AS domiciliario_apellido
     FROM dispensaciones d
     INNER JOIN sedes s ON s.id_sede = d.id_sede
     INNER JOIN almacenes a ON a.id_almacen = d.id_almacen
     INNER JOIN pacientes p ON p.id_paciente = d.id_paciente
     LEFT JOIN domiciliarios dom ON dom.id_domiciliario = d.id_domiciliario
     WHERE (? = '' OR d.consecutivo LIKE ? OR d.receptor_nombre LIKE ? OR p.nombre LIKE ? OR p.documento LIKE ?)
     ORDER BY d.fecha_hora DESC`,
    [filter, wildcard, wildcard, wildcard, wildcard]
  );

  const details = await query(
    `SELECT
        dd.id_dispensacion,
        dd.nombre_comercial,
        dd.principio_activo,
        dd.concentracion,
        dd.cantidad,
        dd.temperatura_entrega,
        dd.requiere_cadena_frio,
        dd.es_controlado,
        l.numero_lote
     FROM dispensaciones_detalle dd
     INNER JOIN lotes l ON l.id_lote = dd.id_lote
     INNER JOIN dispensaciones d ON d.id_dispensacion = dd.id_dispensacion
     INNER JOIN pacientes p ON p.id_paciente = d.id_paciente
     WHERE (? = '' OR d.consecutivo LIKE ? OR d.receptor_nombre LIKE ? OR p.nombre LIKE ? OR p.documento LIKE ?)
     ORDER BY dd.id_dispensacion ASC, dd.id_dispensacion_detalle ASC`,
    [filter, wildcard, wildcard, wildcard, wildcard]
  );

  return { filter, headers, details };
}

function buildDispensingReport(filter, headers, details) {
  const detailMap = new Map();
  for (const row of details) {
    const list = detailMap.get(row.id_dispensacion) ?? [];
    list.push(row);
    detailMap.set(row.id_dispensacion, list);
  }

  const items = headers.map((row) => ({
    ...row,
    detalle: detailMap.get(row.id_dispensacion) ?? [],
    unidades: (detailMap.get(row.id_dispensacion) ?? []).reduce((acc, item) => acc + toNumber(item.cantidad), 0)
  }));

  const bySite = new Map();
  for (const item of items) {
    const current = bySite.get(item.sede) ?? { sede: item.sede, dispensaciones: 0, unidades: 0 };
    current.dispensaciones += 1;
    current.unidades += item.unidades;
    bySite.set(item.sede, current);
  }

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary: {
      dispensaciones: items.length,
      unidades: items.reduce((acc, item) => acc + toNumber(item.unidades), 0),
      pacientes: new Set(items.map((item) => item.paciente_documento)).size,
      domiciliarios: items.filter((item) => item.receptor_tipo === 'domiciliario').length,
      cadena_frio: details.filter((item) => normalizeBoolean(item.requiere_cadena_frio)).length,
      controlados: details.filter((item) => normalizeBoolean(item.es_controlado)).length
    },
    bySite: Array.from(bySite.values()),
    items
  };
}

function buildDispensingExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 120, type: 'string' }
      ],
      rows: [
        { metrica: 'Generado', valor: data.generatedAt },
        { metrica: 'Filtro', valor: data.filter || 'Sin filtro' },
        { metrica: 'Dispensaciones', valor: data.summary.dispensaciones },
        { metrica: 'Unidades', valor: data.summary.unidades },
        { metrica: 'Pacientes únicos', valor: data.summary.pacientes },
        { metrica: 'Recepciones por domiciliario', valor: data.summary.domiciliarios },
        { metrica: 'Ítems de cadena de frío', valor: data.summary.cadena_frio },
        { metrica: 'Ítems controlados', valor: data.summary.controlados }
      ]
    },
    {
      name: 'Dispensaciones',
      columns: [
        { key: 'consecutivo', label: 'Consecutivo', width: 100, type: 'string' },
        { key: 'fecha_hora', label: 'Fecha', width: 120, type: 'string' },
        { key: 'sede', label: 'Sede', width: 140, type: 'string' },
        { key: 'paciente', label: 'Paciente', width: 180, type: 'string' },
        { key: 'paciente_documento', label: 'Documento', width: 100, type: 'string' },
        { key: 'receptor_tipo', label: 'Tipo receptor', width: 100, type: 'string' },
        { key: 'receptor_nombre', label: 'Receptor', width: 180, type: 'string' },
        { key: 'unidades', label: 'Unidades', width: 80, type: 'number' }
      ],
      rows: data.items
    },
    {
      name: 'Detalle',
      columns: [
        { key: 'id_dispensacion', label: 'ID', width: 60, type: 'number' },
        { key: 'nombre_comercial', label: 'Medicamento', width: 180, type: 'string' },
        { key: 'principio_activo', label: 'Principio activo', width: 160, type: 'string' },
        { key: 'concentracion', label: 'Concentración', width: 90, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 90, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 70, type: 'number' },
        { key: 'temperatura_entrega', label: 'Temp. entrega', width: 90, type: 'number' },
        { key: 'requiere_cadena_frio', label: 'Frío', width: 60, type: 'string' },
        { key: 'es_controlado', label: 'Controlado', width: 70, type: 'string' }
      ],
      rows: data.items.flatMap((item) => item.detalle.map((detail) => ({
        ...detail,
        requiere_cadena_frio: normalizeBoolean(detail.requiere_cadena_frio) ? 'Sí' : 'No',
        es_controlado: normalizeBoolean(detail.es_controlado) ? 'Sí' : 'No'
      })))
    }
  ]);
}

function buildDispensingPdf(data) {
  const lines = [];
  lines.push(`Filtro: ${data.filter || 'Sin filtro'}`);
  lines.push(`Dispensaciones: ${data.summary.dispensaciones} | Unidades: ${data.summary.unidades} | Pacientes: ${data.summary.pacientes}`);
  lines.push('', 'DISPENSACIONES RECIENTES');
  lines.push(...tableLines([
    { key: 'consecutivo', label: 'CONSECUTIVO', width: 14 },
    { key: 'fecha_hora', label: 'FECHA', width: 19 },
    { key: 'sede', label: 'SEDE', width: 18 },
    { key: 'paciente', label: 'PACIENTE', width: 20 },
    { key: 'receptor_nombre', label: 'RECEPTOR', width: 20 },
    { key: 'unidades', label: 'UNID', width: 6, align: 'right' }
  ], data.items));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE DISPENSACION',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

export async function createDispensingExport(format, search = '', userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchDispensingDataset(search);
  const data = buildDispensingReport(dataset.filter, dataset.headers, dataset.details);
  const fileBase = `akripharmacy-dispensacion-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'DISPENSACION',
    descripcion: `Exportación de dispensación en formato ${normalizedFormat}${dataset.filter ? ` con filtro ${dataset.filter}` : ''}`,
    userId,
    excelBuilder: buildDispensingExcel,
    pdfBuilder: buildDispensingPdf
  });
}
