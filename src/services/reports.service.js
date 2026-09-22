import { pool, query } from '../config/db.js';
import { env } from '../config/env.js';
import { HttpError } from '../utils/http-error.js';
import { writeAudit } from './audit.service.js';
import { getSummary } from './dashboard.service.js';
import { listStock } from './inventory.service.js';
import { getDxPorIdMedFormulacion, getPrescriptorPorIdFormulacion } from './formulacion-hs.service.js';

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

async function fetchPurchasesDataset(search = '', desde = null, hasta = null, idSede = null) {
  const filter = String(search ?? '').trim();
  const like = `%${filter}%`;

  const conditions = [];
  const params = [];
  if (filter) {
    conditions.push(`(
      oc.numero_oc LIKE ? OR COALESCE(p.razon_social, p.nombre) LIKE ? OR oc.estado LIKE ? OR pr.nombre_comercial LIKE ? OR pr.sku LIKE ?
    )`);
    params.push(like, like, like, like, like);
  }
  if (desde) {
    conditions.push('oc.fecha >= ?');
    params.push(desde);
  }
  if (hasta) {
    conditions.push('oc.fecha <= ?');
    params.push(hasta);
  }
  if (idSede) {
    conditions.push('oc.id_sede = ?');
    params.push(idSede);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const orders = await query(
    `SELECT
        oc.id_oc,
        oc.numero_oc,
        oc.fecha,
        oc.estado,
        COALESCE(p.razon_social, p.nombre) AS proveedor,
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
        COALESCE(p.razon_social, p.nombre),
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
        COALESCE(p.razon_social, p.nombre) AS proveedor,
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

// Informes "Entradas" / "Salidas": consolidado de lo registrado en las
// pantallas Movimiento de Entrada / Movimiento de Salida — NO de todo
// movimientos_inventario (eso mezclaría compras, dispensación y traslados,
// que ya son sus propios informes por separado). Se identifican por el
// mismo tipo que ofrecen esas pantallas (parametros_sistema, grupo
// tipo_movimiento_entrada/tipo_movimiento_salida) para no tener que
// mantener la lista de tipos duplicada en dos lugares.
async function fetchMovementTypeValues(direction) {
  const grupo = direction === 'salida' ? 'tipo_movimiento_salida' : 'tipo_movimiento_entrada';
  const rows = await query(`SELECT valor FROM parametros_sistema WHERE grupo = ?`, [grupo]);
  return rows.map((r) => r.valor);
}

async function fetchMovementsDataset(direction, { search = '', desde = null, hasta = null, idSede = null } = {}) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;
  const tipos = await fetchMovementTypeValues(direction);
  if (!tipos.length) return { filter, rows: [] };

  const almacenColumn = direction === 'salida' ? 'm.id_almacen_origen' : 'm.id_almacen_destino';
  const ubicacionColumn = direction === 'salida' ? 'm.id_ubicacion_origen' : 'm.id_ubicacion_destino';

  const placeholders = tipos.map(() => '?').join(',');
  const conditions = [`m.tipo IN (${placeholders})`];
  const params = [...tipos];

  if (filter) {
    conditions.push(`(p.nombre_comercial LIKE ? OR p.sku LIKE ? OR l.numero_lote LIKE ? OR m.motivo LIKE ?)`);
    params.push(wildcard, wildcard, wildcard, wildcard);
  }
  if (desde) {
    conditions.push('m.fecha_hora >= ?');
    params.push(`${desde} 00:00:00`);
  }
  if (hasta) {
    conditions.push('m.fecha_hora <= ?');
    params.push(`${hasta} 23:59:59`);
  }
  if (idSede) {
    conditions.push(`a.id_sede = ?`);
    params.push(idSede);
  }

  const rows = await query(
    `SELECT
        m.id_movimiento, m.fecha_hora, m.tipo, m.cantidad, m.costo_unitario, m.motivo,
        p.sku, p.nombre_comercial,
        l.numero_lote,
        a.nombre AS almacen,
        u.nombre AS ubicacion,
        usr.nombre_completo AS usuario
     FROM movimientos_inventario m
     INNER JOIN productos p ON p.id_producto = m.id_producto
     LEFT JOIN lotes l ON l.id_lote = m.id_lote
     LEFT JOIN almacenes a ON a.id_almacen = ${almacenColumn}
     LEFT JOIN ubicaciones_almacen u ON u.id_ubicacion = ${ubicacionColumn}
     LEFT JOIN usuarios usr ON usr.id_usuario = m.id_usuario
     WHERE ${conditions.join(' AND ')}
     ORDER BY m.fecha_hora DESC`,
    params
  );

  return { filter, rows };
}

function buildMovementsReport(direction, filter, rows) {
  return {
    generatedAt: new Date().toISOString(),
    direction,
    filter,
    summary: {
      registros: rows.length,
      productos: new Set(rows.map((r) => r.sku)).size,
      unidades: Number(rows.reduce((sum, r) => sum + toNumber(r.cantidad), 0).toFixed(3))
    },
    rows
  };
}

function movementsColumns() {
  return [
    { key: 'fecha_hora', label: 'Fecha', width: 130, type: 'string' },
    { key: 'tipo', label: 'Tipo', width: 130, type: 'string' },
    { key: 'sku', label: 'SKU', width: 90, type: 'string' },
    { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
    { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
    { key: 'cantidad', label: 'Cantidad', width: 90, type: 'number' },
    { key: 'costo_unitario', label: 'Costo unitario', width: 90, type: 'number' },
    { key: 'almacen', label: 'Almacén', width: 150, type: 'string' },
    { key: 'ubicacion', label: 'Ubicación', width: 130, type: 'string' },
    { key: 'motivo', label: 'Motivo', width: 200, type: 'string' },
    { key: 'usuario', label: 'Usuario', width: 160, type: 'string' }
  ];
}

function buildMovementsExcel(data) {
  const titulo = data.direction === 'salida' ? 'Salidas' : 'Entradas';
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 210, type: 'string' },
        { key: 'valor', label: 'Valor', width: 140, type: 'string' }
      ],
      rows: [
        { metrica: 'Fecha de generación', valor: data.generatedAt },
        { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
        { metrica: 'Registros', valor: data.summary.registros },
        { metrica: 'Productos únicos', valor: data.summary.productos },
        { metrica: 'Unidades totales', valor: data.summary.unidades }
      ]
    },
    {
      name: titulo,
      columns: movementsColumns(),
      rows: data.rows
    }
  ]);
}

function buildMovementsPdf(data) {
  const titulo = data.direction === 'salida' ? 'SALIDAS' : 'ENTRADAS';
  const lines = [
    `Registros: ${data.summary.registros}`,
    `Productos unicos: ${data.summary.productos}`,
    `Unidades totales: ${data.summary.unidades}`,
    ''
  ];
  lines.push(...tableLines([
    { key: 'fecha_hora', label: 'FECHA', width: 16 },
    { key: 'tipo', label: 'TIPO', width: 16 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 28 },
    { key: 'numero_lote', label: 'LOTE', width: 12 },
    { key: 'cantidad', label: 'CANT', width: 8, align: 'right' },
    { key: 'almacen', label: 'ALMACEN', width: 16 }
  ], data.rows));

  return buildPdfDocument({
    title: `AKRIPHARMACY - REPORTE DE ${titulo}`,
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function createMovementsExport(direction, format, params, userId) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchMovementsDataset(direction, params);
  const data = buildMovementsReport(direction, dataset.filter, dataset.rows);
  const nombreArchivo = direction === 'salida' ? 'salidas' : 'entradas';
  const fileBase = `akripharmacy-${nombreArchivo}-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: direction === 'salida' ? 'SALIDAS' : 'ENTRADAS',
    descripcion: `Exportación de ${nombreArchivo} en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildMovementsExcel,
    pdfBuilder: buildMovementsPdf
  });
}

export async function createEntradasExport(format, params = {}, userId = null) {
  return createMovementsExport('entrada', format, params, userId);
}

export async function createSalidasExport(format, params = {}, userId = null) {
  return createMovementsExport('salida', format, params, userId);
}

// Informes "Ingresos" / "Devoluciones" / "Actas de recepción": los tres
// vienen de la misma tabla `ingresos` (una devolución es un ingreso cuya
// referencia empieza con "DEV-", igual que lo distingue ingresos.routes.js
// al registrar el movimiento). "Ingresos" y "Devoluciones" son la cabecera
// consolidada de cada grupo; "Actas de recepción" es el detalle ítem por
// ítem de TODAS las recepciones (ingresos + devoluciones), que es lo que
// documenta un acta física de recepción de mercancía.
async function fetchIngresosDataset({ search = '', desde = null, hasta = null, idSede = null, soloDevoluciones = false } = {}) {
  const filter = String(search ?? '').trim();
  const like = `%${filter}%`;

  const conditions = [];
  if (soloDevoluciones === true) conditions.push(`i.referencia LIKE 'DEV-%'`);
  else if (soloDevoluciones === false) conditions.push(`i.referencia NOT LIKE 'DEV-%'`);
  const params = [];

  if (filter) {
    conditions.push(`(i.referencia LIKE ? OR i.proveedor_nombre LIKE ? OR i.numero_factura LIKE ? OR i.numero_orden_compra LIKE ?)`);
    params.push(like, like, like, like);
  }
  if (desde) {
    conditions.push('i.fecha_recepcion >= ?');
    params.push(desde);
  }
  if (hasta) {
    conditions.push('i.fecha_recepcion <= ?');
    params.push(hasta);
  }
  if (idSede) {
    conditions.push('a.id_sede = ?');
    params.push(idSede);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const headers = await query(
    `SELECT
        i.id_ingreso,
        i.referencia,
        i.estado,
        i.fecha_ingreso,
        i.fecha_recepcion,
        i.numero_factura,
        i.fecha_factura,
        i.numero_orden_compra,
        i.sede,
        i.bodega,
        i.proveedor_nombre,
        i.proveedor_nit,
        i.total_bruto,
        i.total_descuento,
        i.subtotal_neto,
        i.total_iva,
        i.total_ingreso,
        u.nombre_completo AS creado_por_nombre,
        COUNT(it.id_item) AS lineas
     FROM ingresos i
     LEFT JOIN usuarios u ON u.id_usuario = i.creado_por
     LEFT JOIN almacenes a ON a.id_almacen = i.id_almacen
     LEFT JOIN ingresos_items it ON it.id_ingreso = i.id_ingreso
     ${where}
     GROUP BY
        i.id_ingreso, i.referencia, i.estado, i.fecha_ingreso, i.fecha_recepcion,
        i.numero_factura, i.fecha_factura, i.numero_orden_compra, i.sede, i.bodega,
        i.proveedor_nombre, i.proveedor_nit, i.total_bruto, i.total_descuento,
        i.subtotal_neto, i.total_iva, i.total_ingreso, u.nombre_completo
     ORDER BY i.fecha_ingreso DESC, i.id_ingreso DESC`,
    params
  );

  const details = await query(
    `SELECT
        i.referencia,
        i.fecha_ingreso,
        i.proveedor_nombre,
        it.codigo,
        it.nombre,
        it.laboratorio,
        it.cantidad,
        it.valor_unitario,
        it.descuento_valor,
        it.iva,
        it.lote,
        it.fecha_vencimiento
     FROM ingresos_items it
     INNER JOIN ingresos i ON i.id_ingreso = it.id_ingreso
     LEFT JOIN almacenes a ON a.id_almacen = i.id_almacen
     ${where}
     ORDER BY i.fecha_ingreso DESC, i.referencia DESC`,
    params
  );

  return { filter, headers, details };
}

function buildIngresosReport(filter, headers, details) {
  const summary = {
    registros: headers.length,
    proveedores: new Set(headers.map((row) => row.proveedor_nombre).filter(Boolean)).size,
    total_ingreso: Number(headers.reduce((sum, row) => sum + toNumber(row.total_ingreso), 0).toFixed(2)),
    total_iva: Number(headers.reduce((sum, row) => sum + toNumber(row.total_iva), 0).toFixed(2)),
    unidades: Number(details.reduce((sum, row) => sum + toNumber(row.cantidad), 0).toFixed(3)),
    pendiente: headers.filter((row) => row.estado === 'pendiente').length,
    recibido: headers.filter((row) => row.estado === 'recibido').length,
    almacenado: headers.filter((row) => row.estado === 'almacenado').length,
    cancelado: headers.filter((row) => row.estado === 'cancelado').length
  };

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary,
    headers,
    details
  };
}

function ingresosSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'Registros', valor: data.summary.registros },
    { metrica: 'Proveedores involucrados', valor: data.summary.proveedores },
    { metrica: 'Total ingresado', valor: data.summary.total_ingreso },
    { metrica: 'IVA acumulado', valor: data.summary.total_iva },
    { metrica: 'Unidades recibidas', valor: data.summary.unidades },
    { metrica: 'Pendientes', valor: data.summary.pendiente },
    { metrica: 'Recibidos', valor: data.summary.recibido },
    { metrica: 'Almacenados', valor: data.summary.almacenado },
    { metrica: 'Cancelados', valor: data.summary.cancelado }
  ];
}

function ingresosHeaderColumns() {
  return [
    { key: 'referencia', label: 'Referencia', width: 100, type: 'string' },
    { key: 'estado', label: 'Estado', width: 90, type: 'string' },
    { key: 'fecha_ingreso', label: 'Fecha ingreso', width: 110, type: 'string' },
    { key: 'fecha_recepcion', label: 'Fecha recepción', width: 100, type: 'string' },
    { key: 'numero_factura', label: 'Nro factura', width: 90, type: 'string' },
    { key: 'numero_orden_compra', label: 'OC asociada', width: 100, type: 'string' },
    { key: 'sede', label: 'Sede', width: 100, type: 'string' },
    { key: 'bodega', label: 'Bodega', width: 100, type: 'string' },
    { key: 'proveedor_nombre', label: 'Proveedor', width: 180, type: 'string' },
    { key: 'proveedor_nit', label: 'NIT', width: 90, type: 'string' },
    { key: 'lineas', label: 'Líneas', width: 60, type: 'number' },
    { key: 'total_bruto', label: 'Total bruto', width: 90, type: 'number' },
    { key: 'total_descuento', label: 'Descuento', width: 80, type: 'number' },
    { key: 'subtotal_neto', label: 'Subtotal neto', width: 90, type: 'number' },
    { key: 'total_iva', label: 'IVA', width: 80, type: 'number' },
    { key: 'total_ingreso', label: 'Total', width: 90, type: 'number' },
    { key: 'creado_por_nombre', label: 'Registrado por', width: 140, type: 'string' }
  ];
}

function ingresosDetailColumns() {
  return [
    { key: 'referencia', label: 'Referencia', width: 100, type: 'string' },
    { key: 'fecha_ingreso', label: 'Fecha ingreso', width: 110, type: 'string' },
    { key: 'proveedor_nombre', label: 'Proveedor', width: 180, type: 'string' },
    { key: 'codigo', label: 'Código', width: 90, type: 'string' },
    { key: 'nombre', label: 'Producto', width: 220, type: 'string' },
    { key: 'laboratorio', label: 'Laboratorio', width: 140, type: 'string' },
    { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
    { key: 'valor_unitario', label: 'Valor unitario', width: 90, type: 'number' },
    { key: 'descuento_valor', label: 'Descuento', width: 80, type: 'number' },
    { key: 'iva', label: 'IVA %', width: 60, type: 'number' },
    { key: 'lote', label: 'Lote', width: 90, type: 'string' },
    { key: 'fecha_vencimiento', label: 'Vencimiento', width: 100, type: 'string' }
  ];
}

function buildIngresosExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: ingresosSummaryRows(data)
    },
    { name: 'Cabecera', columns: ingresosHeaderColumns(), rows: data.headers },
    { name: 'Detalle', columns: ingresosDetailColumns(), rows: data.details }
  ]);
}

function buildIngresosPdf(data, titulo) {
  const lines = [];
  lines.push(...ingresosSummaryRows(data).map((row) => `${pad(row.metrica, 30)} : ${asciiSafe(row.valor)}`));
  lines.push('', titulo);
  lines.push(...tableLines([
    { key: 'referencia', label: 'REF', width: 14 },
    { key: 'fecha_ingreso', label: 'FECHA', width: 18 },
    { key: 'proveedor_nombre', label: 'PROVEEDOR', width: 26 },
    { key: 'estado', label: 'ESTADO', width: 14 },
    { key: 'total_ingreso', label: 'TOTAL', width: 12, align: 'right' }
  ], data.headers));

  return buildPdfDocument({
    title: `AKRIPHARMACY - REPORTE DE ${titulo}`,
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

async function fetchActasDataset({ search = '', desde = null, hasta = null, idSede = null } = {}) {
  return fetchIngresosDataset({ search, desde, hasta, idSede, soloDevoluciones: null });
}

function buildActasExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: ingresosSummaryRows(data)
    },
    { name: 'Actas', columns: ingresosDetailColumns(), rows: data.details }
  ]);
}

function buildActasPdf(data) {
  const lines = [];
  lines.push(...ingresosSummaryRows(data).map((row) => `${pad(row.metrica, 30)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'ACTAS DE RECEPCION');
  lines.push(...tableLines([
    { key: 'referencia', label: 'REF', width: 14 },
    { key: 'fecha_ingreso', label: 'FECHA', width: 18 },
    { key: 'nombre', label: 'PRODUCTO', width: 26 },
    { key: 'lote', label: 'LOTE', width: 12 },
    { key: 'cantidad', label: 'CANT', width: 8, align: 'right' }
  ], data.details));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - ACTAS DE RECEPCION',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

export async function createIngresosExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchIngresosDataset({ ...params, soloDevoluciones: false });
  const data = buildIngresosReport(dataset.filter, dataset.headers, dataset.details);
  const fileBase = `akripharmacy-ingresos-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'INGRESOS',
    descripcion: `Exportación de ingresos en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildIngresosExcel,
    pdfBuilder: (d) => buildIngresosPdf(d, 'INGRESOS')
  });
}

export async function createDevolucionesExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchIngresosDataset({ ...params, soloDevoluciones: true });
  const data = buildIngresosReport(dataset.filter, dataset.headers, dataset.details);
  const fileBase = `akripharmacy-devoluciones-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'DEVOLUCIONES',
    descripcion: `Exportación de devoluciones en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildIngresosExcel,
    pdfBuilder: (d) => buildIngresosPdf(d, 'DEVOLUCIONES')
  });
}

export async function createActasExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchActasDataset(params);
  const data = buildIngresosReport(dataset.filter, dataset.headers, dataset.details);
  const fileBase = `akripharmacy-actas-recepcion-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'ACTAS_RECEPCION',
    descripcion: `Exportación de actas de recepción en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildActasExcel,
    pdfBuilder: buildActasPdf
  });
}

// Informe "Movimientos por producto": a diferencia de "Entradas"/"Salidas"
// (que solo cubren lo registrado en esas dos pantallas puntuales), este es
// el historial COMPLETO de movimientos_inventario de un MX — compras,
// dispensación, traslados, ajustes, todo — igual que "Consulta de
// movimientos por producto" lo pide el requerimiento original. Un
// movimiento puede tener almacén de origen, de destino, o ambos (traslado);
// el filtro de sede aplica si CUALQUIERA de los dos coincide.
async function fetchProductMovementsDataset({ search = '', desde = null, hasta = null, idSede = null } = {}) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const conditions = [];
  const params = [];
  if (filter) {
    conditions.push(`(p.nombre_comercial LIKE ? OR p.sku LIKE ? OR l.numero_lote LIKE ? OR m.motivo LIKE ? OR m.tipo LIKE ?)`);
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard);
  }
  if (desde) {
    conditions.push('m.fecha_hora >= ?');
    params.push(`${desde} 00:00:00`);
  }
  if (hasta) {
    conditions.push('m.fecha_hora <= ?');
    params.push(`${hasta} 23:59:59`);
  }
  if (idSede) {
    conditions.push('(almO.id_sede = ? OR almD.id_sede = ?)');
    params.push(idSede, idSede);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT
        m.id_movimiento,
        m.fecha_hora,
        m.tipo,
        p.sku,
        p.nombre_comercial,
        l.numero_lote,
        m.cantidad,
        m.costo_unitario,
        m.motivo,
        almO.nombre AS almacen_origen,
        almD.nombre AS almacen_destino,
        COALESCE(sedO.nombre, sedD.nombre) AS sede,
        u.nombre_completo AS usuario,
        m.referencia_tipo,
        m.referencia_id
     FROM movimientos_inventario m
     INNER JOIN productos p ON p.id_producto = m.id_producto
     LEFT JOIN lotes l ON l.id_lote = m.id_lote
     LEFT JOIN almacenes almO ON almO.id_almacen = m.id_almacen_origen
     LEFT JOIN almacenes almD ON almD.id_almacen = m.id_almacen_destino
     LEFT JOIN sedes sedO ON sedO.id_sede = almO.id_sede
     LEFT JOIN sedes sedD ON sedD.id_sede = almD.id_sede
     LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario
     ${where}
     ORDER BY m.fecha_hora DESC`,
    params
  );

  return { filter, rows };
}

function buildProductMovementsReport(filter, rows) {
  const byProductMap = new Map();
  for (const row of rows) {
    const key = row.sku || row.nombre_comercial;
    const current = byProductMap.get(key) ?? { sku: row.sku, nombre_comercial: row.nombre_comercial, registros: 0, unidades: 0 };
    current.registros += 1;
    current.unidades += toNumber(row.cantidad);
    byProductMap.set(key, current);
  }

  const byTipoMap = new Map();
  for (const row of rows) {
    const current = byTipoMap.get(row.tipo) ?? { tipo: row.tipo, registros: 0, unidades: 0 };
    current.registros += 1;
    current.unidades += toNumber(row.cantidad);
    byTipoMap.set(row.tipo, current);
  }

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary: {
      registros: rows.length,
      productos: byProductMap.size,
      lotes: new Set(rows.map((row) => row.numero_lote).filter(Boolean)).size,
      unidades: Number(rows.reduce((sum, row) => sum + toNumber(row.cantidad), 0).toFixed(3)),
      tipos_distintos: byTipoMap.size
    },
    porProducto: Array.from(byProductMap.values()).sort((a, b) => b.registros - a.registros),
    porTipo: Array.from(byTipoMap.values()).sort((a, b) => b.registros - a.registros),
    rows
  };
}

function productMovementsSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'Registros', valor: data.summary.registros },
    { metrica: 'Productos con movimientos', valor: data.summary.productos },
    { metrica: 'Lotes involucrados', valor: data.summary.lotes },
    { metrica: 'Unidades movidas', valor: data.summary.unidades },
    { metrica: 'Tipos de movimiento distintos', valor: data.summary.tipos_distintos }
  ];
}

function buildProductMovementsExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: productMovementsSummaryRows(data)
    },
    {
      name: 'PorProducto',
      columns: [
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'registros', label: 'Registros', width: 90, type: 'number' },
        { key: 'unidades', label: 'Unidades', width: 90, type: 'number' }
      ],
      rows: data.porProducto
    },
    {
      name: 'Detalle',
      columns: [
        { key: 'fecha_hora', label: 'Fecha', width: 130, type: 'string' },
        { key: 'tipo', label: 'Tipo', width: 110, type: 'string' },
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'nombre_comercial', label: 'Producto', width: 220, type: 'string' },
        { key: 'numero_lote', label: 'Lote', width: 100, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
        { key: 'costo_unitario', label: 'Costo unitario', width: 90, type: 'number' },
        { key: 'almacen_origen', label: 'Almacén origen', width: 140, type: 'string' },
        { key: 'almacen_destino', label: 'Almacén destino', width: 140, type: 'string' },
        { key: 'sede', label: 'Sede', width: 120, type: 'string' },
        { key: 'motivo', label: 'Motivo', width: 180, type: 'string' },
        { key: 'usuario', label: 'Usuario', width: 150, type: 'string' },
        { key: 'referencia_tipo', label: 'Referencia', width: 130, type: 'string' }
      ],
      rows: data.rows
    }
  ]);
}

function buildProductMovementsPdf(data) {
  const lines = [];
  lines.push(...productMovementsSummaryRows(data).map((row) => `${pad(row.metrica, 30)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'MOVIMIENTOS');
  lines.push(...tableLines([
    { key: 'fecha_hora', label: 'FECHA', width: 16 },
    { key: 'tipo', label: 'TIPO', width: 18 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 26 },
    { key: 'numero_lote', label: 'LOTE', width: 12 },
    { key: 'cantidad', label: 'CANT', width: 8, align: 'right' }
  ], data.rows));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - MOVIMIENTOS POR PRODUCTO',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

export async function createProductMovementsExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchProductMovementsDataset(params);
  const data = buildProductMovementsReport(dataset.filter, dataset.rows);
  const fileBase = `akripharmacy-movimientos-producto-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'MOVIMIENTOS_PRODUCTO',
    descripcion: `Exportación de movimientos por producto en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildProductMovementsExcel,
    pdfBuilder: buildProductMovementsPdf
  });
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

export async function createInventoryExport(format, search = '', userId = null, idSede = null) {
  const normalizedFormat = normalizeFormat(format);
  const rows = await listStock(search, null, null, idSede);
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

export async function createPurchasesExport(format, search = '', userId = null, { desde = null, hasta = null, idSede = null } = {}) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchPurchasesDataset(search, desde, hasta, idSede);
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


// Informe "Dispensación": la dispensación real de AkriPharmacy corre sobre
// el flujo HealthSphere (dispensacion_hs_control + movimientos_inventario),
// NO sobre las tablas legacy `dispensaciones`/`dispensaciones_detalle` (esas
// pertenecen a un flujo manual que ya no es el que usa la pantalla de
// Dispensación real — ver dispensacion-hs.service.js). `cantidad_dispensada`
// y `estado` en dispensacion_hs_control YA vienen netos de anulaciones
// (anularEntregaHS los resta ahí mismo), así que la cabecera no necesita
// recalcular nada. El detalle sí necesita marcar cada entrega anulada
// explícitamente, igual que hace getHistorialEntregas().
async function fetchDispensingDataset({ search = '', desde = null, hasta = null, idSede = null } = {}) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const conditions = [];
  const params = [];
  if (filter) {
    conditions.push(`(c.nombre_paciente LIKE ? OR c.documento_paciente LIKE ? OR c.nombre_medicamento LIKE ?)`);
    params.push(wildcard, wildcard, wildcard);
  }
  if (desde) {
    conditions.push('c.fecha_formulacion >= ?');
    params.push(desde);
  }
  if (hasta) {
    conditions.push('c.fecha_formulacion <= ?');
    params.push(hasta);
  }
  if (idSede) {
    conditions.push('almref.id_sede = ?');
    params.push(idSede);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Un control no guarda su propia sede/almacén — se infiere del último
  // movimiento de entrega real que generó (si aún no se ha dispensado nada,
  // queda sin sede, lo cual es correcto: todavía no se entregó en ningún
  // lugar físico).
  const movrefJoin = `
     LEFT JOIN (
       SELECT m1.referencia_id, m1.id_almacen_origen
       FROM movimientos_inventario m1
       INNER JOIN (
         SELECT referencia_id, MAX(fecha_hora) AS max_fecha
         FROM movimientos_inventario
         WHERE referencia_tipo = 'DISPENSACION_HS_CONTROL'
         GROUP BY referencia_id
       ) mx ON mx.referencia_id = m1.referencia_id AND mx.max_fecha = m1.fecha_hora
       WHERE m1.referencia_tipo = 'DISPENSACION_HS_CONTROL'
       GROUP BY m1.referencia_id, m1.id_almacen_origen
     ) movref_almacen ON movref_almacen.referencia_id = c.id
     LEFT JOIN almacenes almref ON almref.id_almacen = movref_almacen.id_almacen_origen
     LEFT JOIN sedes sedref ON sedref.id_sede = almref.id_sede`;

  const headers = await query(
    `SELECT
        c.id,
        c.id_formulacion_hs,
        c.id_med_formulacion_hs,
        c.nombre_paciente,
        c.documento_paciente,
        c.nombre_medicamento,
        c.presentacion,
        c.cantidad_formulada,
        c.cantidad_dispensada,
        c.estado,
        c.fecha_formulacion,
        c.fecha_dispensacion,
        c.contrato,
        c.regimen,
        c.observaciones,
        u.nombre_completo AS usuario_nombre,
        almref.nombre AS almacen,
        sedref.nombre AS sede
     FROM dispensacion_hs_control c
     LEFT JOIN usuarios u ON u.id_usuario = c.id_usuario
     ${movrefJoin}
     ${where}
     ORDER BY c.fecha_creacion DESC`,
    params
  );

  const detailConditions = [];
  const detailParams = [];
  if (filter) {
    detailConditions.push(`(c.nombre_paciente LIKE ? OR c.documento_paciente LIKE ? OR c.nombre_medicamento LIKE ?)`);
    detailParams.push(wildcard, wildcard, wildcard);
  }
  if (desde) {
    detailConditions.push('m.fecha_hora >= ?');
    detailParams.push(`${desde} 00:00:00`);
  }
  if (hasta) {
    detailConditions.push('m.fecha_hora <= ?');
    detailParams.push(`${hasta} 23:59:59`);
  }
  if (idSede) {
    detailConditions.push('a.id_sede = ?');
    detailParams.push(idSede);
  }
  const detailWhere = detailConditions.length ? `WHERE ${detailConditions.join(' AND ')}` : '';

  const details = await query(
    `SELECT
        c.id AS id_control,
        c.nombre_paciente,
        c.documento_paciente,
        c.nombre_medicamento,
        m.id_movimiento,
        m.fecha_hora,
        m.cantidad,
        l.numero_lote,
        a.nombre AS almacen,
        s.nombre AS sede,
        u.nombre_completo AS usuario,
        (anul.id_movimiento IS NOT NULL) AS anulado
     FROM movimientos_inventario m
     INNER JOIN dispensacion_hs_control c ON c.id = m.referencia_id
     LEFT JOIN lotes l ON l.id_lote = m.id_lote
     LEFT JOIN almacenes a ON a.id_almacen = m.id_almacen_origen
     LEFT JOIN sedes s ON s.id_sede = a.id_sede
     LEFT JOIN usuarios u ON u.id_usuario = m.id_usuario
     LEFT JOIN movimientos_inventario anul
       ON anul.referencia_tipo = 'ANULACION_DISPENSACION_HS' AND anul.referencia_id = m.id_movimiento
     WHERE m.referencia_tipo = 'DISPENSACION_HS_CONTROL'
       ${detailWhere ? `AND ${detailConditions.join(' AND ')}` : ''}
     ORDER BY m.fecha_hora DESC`,
    detailParams
  );

  return { filter, headers, details };
}

function buildDispensingReport(filter, headers, details) {
  // El detalle de entregas ANULADAS se conserva en la hoja de trazabilidad
  // (para no perder el histórico) pero se excluye de las sumas reales, igual
  // que hace el módulo de Dispensación en pantalla.
  const detallesReales = details.filter((d) => !normalizeBoolean(d.anulado));

  const bySite = new Map();
  for (const row of headers) {
    const key = row.sede || 'Sin asignar';
    const current = bySite.get(key) ?? { sede: key, registros: 0, cantidad_dispensada: 0 };
    current.registros += 1;
    current.cantidad_dispensada += toNumber(row.cantidad_dispensada);
    bySite.set(key, current);
  }

  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary: {
      registros: headers.length,
      pacientes: new Set(headers.map((row) => row.documento_paciente).filter(Boolean)).size,
      cantidad_formulada: Number(headers.reduce((sum, row) => sum + toNumber(row.cantidad_formulada), 0).toFixed(2)),
      cantidad_dispensada: Number(headers.reduce((sum, row) => sum + toNumber(row.cantidad_dispensada), 0).toFixed(2)),
      pendiente: headers.filter((row) => row.estado === 'pendiente').length,
      parcial: headers.filter((row) => row.estado === 'parcial').length,
      dispensado: headers.filter((row) => row.estado === 'dispensado').length,
      cancelado: headers.filter((row) => row.estado === 'cancelado').length,
      entregas_reales: detallesReales.length,
      entregas_anuladas: details.length - detallesReales.length
    },
    bySite: Array.from(bySite.values()),
    headers,
    details
  };
}

function dispensingSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'Registros (formulado × medicamento)', valor: data.summary.registros },
    { metrica: 'Pacientes únicos', valor: data.summary.pacientes },
    { metrica: 'Cantidad formulada', valor: data.summary.cantidad_formulada },
    { metrica: 'Cantidad dispensada (neta de anulaciones)', valor: data.summary.cantidad_dispensada },
    { metrica: 'Pendientes', valor: data.summary.pendiente },
    { metrica: 'Parciales', valor: data.summary.parcial },
    { metrica: 'Dispensados completos', valor: data.summary.dispensado },
    { metrica: 'Cancelados', valor: data.summary.cancelado },
    { metrica: 'Entregas reales', valor: data.summary.entregas_reales },
    { metrica: 'Entregas anuladas', valor: data.summary.entregas_anuladas }
  ];
}

function buildDispensingExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 260, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: dispensingSummaryRows(data)
    },
    {
      name: 'FormulaVsDispensado',
      columns: [
        { key: 'nombre_paciente', label: 'Paciente', width: 180, type: 'string' },
        { key: 'documento_paciente', label: 'Documento', width: 100, type: 'string' },
        { key: 'nombre_medicamento', label: 'Medicamento', width: 220, type: 'string' },
        { key: 'presentacion', label: 'Presentación', width: 120, type: 'string' },
        { key: 'cantidad_formulada', label: 'Formulado', width: 90, type: 'number' },
        { key: 'cantidad_dispensada', label: 'Dispensado', width: 90, type: 'number' },
        { key: 'estado', label: 'Estado', width: 90, type: 'string' },
        { key: 'fecha_formulacion', label: 'Fecha formulación', width: 110, type: 'string' },
        { key: 'fecha_dispensacion', label: 'Última dispensación', width: 130, type: 'string' },
        { key: 'sede', label: 'Sede', width: 120, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 120, type: 'string' },
        { key: 'contrato', label: 'Contrato', width: 100, type: 'string' },
        { key: 'regimen', label: 'Régimen', width: 100, type: 'string' }
      ],
      rows: data.headers
    },
    {
      name: 'EntregasReales',
      columns: [
        { key: 'fecha_hora', label: 'Fecha entrega', width: 130, type: 'string' },
        { key: 'nombre_paciente', label: 'Paciente', width: 180, type: 'string' },
        { key: 'nombre_medicamento', label: 'Medicamento', width: 220, type: 'string' },
        { key: 'cantidad', label: 'Cantidad', width: 80, type: 'number' },
        { key: 'numero_lote', label: 'Lote', width: 90, type: 'string' },
        { key: 'sede', label: 'Sede', width: 120, type: 'string' },
        { key: 'almacen', label: 'Almacén', width: 120, type: 'string' },
        { key: 'usuario', label: 'Usuario', width: 150, type: 'string' },
        { key: 'anulado', label: 'Anulado', width: 70, type: 'string' }
      ],
      rows: data.details.map((row) => ({ ...row, anulado: normalizeBoolean(row.anulado) ? 'Sí' : 'No' }))
    }
  ]);
}

function buildDispensingPdf(data) {
  const lines = [];
  lines.push(...dispensingSummaryRows(data).map((row) => `${pad(row.metrica, 40)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'FORMULADO VS DISPENSADO');
  lines.push(...tableLines([
    { key: 'nombre_paciente', label: 'PACIENTE', width: 22 },
    { key: 'nombre_medicamento', label: 'MEDICAMENTO', width: 26 },
    { key: 'cantidad_formulada', label: 'FORM', width: 7, align: 'right' },
    { key: 'cantidad_dispensada', label: 'DISP', width: 7, align: 'right' },
    { key: 'estado', label: 'ESTADO', width: 12 }
  ], data.headers));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - REPORTE DE DISPENSACION',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

// Informe "Listado maestro": catálogo completo de MX con todas las
// variables que contempla el formulario de creación (mismo set de columnas
// que ensureProductExists() en product.service.js), más los nombres
// legibles (categoría, forma, laboratorio) y el stock actual. El filtro de
// Sede/Bodega no es una columna directa de `productos` (el catálogo es
// global) — se resuelve por EXISTS contra lotes/existencias/almacenes,
// igual que hace listStock() para "Consulta de inventarios".
async function fetchMaestroDataset({ search = '', desde = null, hasta = null, idSede = null } = {}) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const conditions = [];
  const params = [];
  if (filter) {
    conditions.push(`(p.nombre_comercial LIKE ? OR p.sku LIKE ? OR p.principio_activo LIKE ? OR p.codigo_barras LIKE ? OR p.codigo_control LIKE ?)`);
    params.push(wildcard, wildcard, wildcard, wildcard, wildcard);
  }
  if (desde) {
    conditions.push('p.fecha_creacion >= ?');
    params.push(`${desde} 00:00:00`);
  }
  if (hasta) {
    conditions.push('p.fecha_creacion <= ?');
    params.push(`${hasta} 23:59:59`);
  }
  if (idSede) {
    conditions.push(`EXISTS (
      SELECT 1 FROM lotes l
      INNER JOIN existencias e ON e.id_lote = l.id_lote
      INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
      WHERE l.id_producto = p.id_producto AND a.id_sede = ?
    )`);
    params.push(idSede);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
    `SELECT
        p.id_producto,
        p.id_medicamento_hs,
        p.sku,
        p.codigo_control,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.presentacion,
        p.unidad_medida,
        p.registro_invima,
        p.cum,
        p.consecutivo_cum,
        p.codigo_atc,
        p.codigo_dci,
        p.clasificacion,
        p.tipo_producto,
        p.mx_control,
        p.es_controlado,
        p.requiere_cadena_frio,
        p.temp_min,
        p.temp_max,
        p.iva_tasa,
        p.costo_referencia,
        p.precio_venta,
        p.stock_minimo,
        p.stock_maximo,
        p.punto_reorden,
        p.activo,
        p.fecha_creacion,
        p.fecha_modificacion,
        cp.nombre AS categoria,
        ff.nombre AS forma_farmaceutica,
        lab.nombre AS laboratorio,
        COALESCE(stock.stock_actual, 0) AS stock_actual
     FROM productos p
     LEFT JOIN categorias_producto cp ON cp.id_categoria = p.id_categoria
     LEFT JOIN formas_farmaceuticas ff ON ff.id_forma = p.id_forma
     LEFT JOIN laboratorios lab ON lab.id_laboratorio = p.id_laboratorio
     LEFT JOIN (
        SELECT l.id_producto, ROUND(COALESCE(SUM(e.cantidad_disponible), 0), 3) AS stock_actual
        FROM lotes l
        LEFT JOIN existencias e ON e.id_lote = l.id_lote
        GROUP BY l.id_producto
     ) stock ON stock.id_producto = p.id_producto
     ${where}
     ORDER BY p.nombre_comercial ASC`,
    params
  );

  return { filter, rows };
}

function buildMaestroReport(filter, rows) {
  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary: {
      productos: rows.length,
      activos: countWhere(rows, (row) => normalizeBoolean(row.activo)),
      inactivos: countWhere(rows, (row) => !normalizeBoolean(row.activo)),
      controlados: countWhere(rows, (row) => normalizeBoolean(row.es_controlado)),
      cadena_frio: countWhere(rows, (row) => normalizeBoolean(row.requiere_cadena_frio)),
      stock_bajo_minimo: countWhere(rows, (row) => toNumber(row.stock_actual) < toNumber(row.stock_minimo)),
      sin_stock: countWhere(rows, (row) => toNumber(row.stock_actual) <= 0)
    },
    rows
  };
}

function maestroSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'Productos', valor: data.summary.productos },
    { metrica: 'Activos', valor: data.summary.activos },
    { metrica: 'Inactivos', valor: data.summary.inactivos },
    { metrica: 'Controlados', valor: data.summary.controlados },
    { metrica: 'Cadena de frío', valor: data.summary.cadena_frio },
    { metrica: 'Bajo stock mínimo', valor: data.summary.stock_bajo_minimo },
    { metrica: 'Sin stock', valor: data.summary.sin_stock }
  ];
}

function buildMaestroExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 220, type: 'string' },
        { key: 'valor', label: 'Valor', width: 130, type: 'string' }
      ],
      rows: maestroSummaryRows(data)
    },
    {
      name: 'Maestro',
      columns: [
        { key: 'sku', label: 'SKU', width: 90, type: 'string' },
        { key: 'codigo_control', label: 'Código control', width: 100, type: 'string' },
        { key: 'codigo_barras', label: 'Código barras', width: 110, type: 'string' },
        { key: 'nombre_comercial', label: 'Nombre comercial', width: 220, type: 'string' },
        { key: 'principio_activo', label: 'Principio activo', width: 200, type: 'string' },
        { key: 'concentracion', label: 'Concentración', width: 100, type: 'string' },
        { key: 'presentacion', label: 'Presentación', width: 90, type: 'string' },
        { key: 'unidad_medida', label: 'Unidad medida', width: 90, type: 'string' },
        { key: 'registro_invima', label: 'Registro INVIMA', width: 110, type: 'string' },
        { key: 'cum', label: 'CUM', width: 90, type: 'string' },
        { key: 'consecutivo_cum', label: 'Consecutivo CUM', width: 100, type: 'string' },
        { key: 'codigo_atc', label: 'Código ATC', width: 90, type: 'string' },
        { key: 'codigo_dci', label: 'Código DCI', width: 90, type: 'string' },
        { key: 'clasificacion', label: 'Clasificación', width: 100, type: 'string' },
        { key: 'categoria', label: 'Categoría', width: 120, type: 'string' },
        { key: 'forma_farmaceutica', label: 'Forma farmacéutica', width: 120, type: 'string' },
        { key: 'laboratorio', label: 'Laboratorio', width: 160, type: 'string' },
        { key: 'tipo_producto', label: 'Tipo producto', width: 100, type: 'string' },
        { key: 'mx_control', label: 'MX control', width: 70, type: 'string' },
        { key: 'es_controlado', label: 'Controlado', width: 70, type: 'string' },
        { key: 'requiere_cadena_frio', label: 'Cadena frío', width: 70, type: 'string' },
        { key: 'temp_min', label: 'Temp mín', width: 70, type: 'number' },
        { key: 'temp_max', label: 'Temp máx', width: 70, type: 'number' },
        { key: 'iva_tasa', label: 'IVA %', width: 60, type: 'number' },
        { key: 'costo_referencia', label: 'Costo referencia', width: 100, type: 'number' },
        { key: 'precio_venta', label: 'Precio venta', width: 100, type: 'number' },
        { key: 'stock_actual', label: 'Stock actual', width: 90, type: 'number' },
        { key: 'stock_minimo', label: 'Stock mínimo', width: 90, type: 'number' },
        { key: 'stock_maximo', label: 'Stock máximo', width: 90, type: 'number' },
        { key: 'punto_reorden', label: 'Punto reorden', width: 90, type: 'number' },
        { key: 'activo', label: 'Activo', width: 60, type: 'string' },
        { key: 'fecha_creacion', label: 'Fecha creación', width: 130, type: 'string' },
        { key: 'fecha_modificacion', label: 'Última modificación', width: 130, type: 'string' }
      ],
      rows: data.rows.map((row) => ({
        ...row,
        mx_control: normalizeBoolean(row.mx_control) ? 'Sí' : 'No',
        es_controlado: normalizeBoolean(row.es_controlado) ? 'Sí' : 'No',
        requiere_cadena_frio: normalizeBoolean(row.requiere_cadena_frio) ? 'Sí' : 'No',
        activo: normalizeBoolean(row.activo) ? 'Sí' : 'No'
      }))
    }
  ]);
}

function buildMaestroPdf(data) {
  const lines = [];
  lines.push(...maestroSummaryRows(data).map((row) => `${pad(row.metrica, 26)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'LISTADO MAESTRO');
  lines.push(...tableLines([
    { key: 'sku', label: 'SKU', width: 12 },
    { key: 'nombre_comercial', label: 'PRODUCTO', width: 30 },
    { key: 'laboratorio', label: 'LABORATORIO', width: 20 },
    { key: 'tipo_producto', label: 'TIPO', width: 14 },
    { key: 'stock_actual', label: 'STOCK', width: 8, align: 'right' },
    { key: 'activo', label: 'ACTIVO', width: 8 }
  ], data.rows.map((row) => ({ ...row, activo: normalizeBoolean(row.activo) ? 'Sí' : 'No' }))));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - LISTADO MAESTRO',
    subtitle: `Generado: ${data.generatedAt}`,
    lines,
    landscape: true
  });
}

export async function createMaestroExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchMaestroDataset(params);
  const data = buildMaestroReport(dataset.filter, dataset.rows);
  const fileBase = `akripharmacy-listado-maestro-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'LISTADO_MAESTRO',
    descripcion: `Exportación de listado maestro en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildMaestroExcel,
    pdfBuilder: buildMaestroPdf
  });
}

export async function createDispensingExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchDispensingDataset(typeof params === 'string' ? { search: params } : params);
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

// Informe "Facturación — RIPS": mientras el Ministerio homologa las
// variables exactas, se entrega el archivo AM (Medicamentos) de la
// estructura estándar RIPS (Resolución 2275/3374) — es el único de los
// archivos RIPS (AF/AC/AP/AM/AU/AH/AN/AT) que le corresponde generar a una
// farmacia dispensadora; AF/AC/AP/AU son responsabilidad del prestador que
// atiende al paciente, no de AkriPharmacy. Se arma sobre
// dispensacion_hs_control (la MISMA fuente que el informe de Dispensación)
// filtrando solo lo realmente entregado (cantidad_dispensada > 0) — lo
// pendiente/anulado no debe facturarse. Cuando llegue la homologación real
// se ajustan nombres/orden de columnas sin tocar el origen de datos.
async function fetchRipsAmDataset({ search = '', desde = null, hasta = null, idSede = null } = {}) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const conditions = ['c.cantidad_dispensada > 0'];
  const params = [];
  if (filter) {
    conditions.push(`(c.nombre_paciente LIKE ? OR c.documento_paciente LIKE ? OR c.nombre_medicamento LIKE ?)`);
    params.push(wildcard, wildcard, wildcard);
  }
  if (desde) {
    conditions.push('c.fecha_dispensacion >= ?');
    params.push(`${desde} 00:00:00`);
  }
  if (hasta) {
    conditions.push('c.fecha_dispensacion <= ?');
    params.push(`${hasta} 23:59:59`);
  }
  if (idSede) {
    conditions.push('almref.id_sede = ?');
    params.push(idSede);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const rows = await query(
    `SELECT
        c.id,
        c.id_formulacion_hs,
        c.id_med_formulacion_hs,
        c.documento_paciente,
        c.nombre_paciente,
        c.nombre_medicamento,
        c.cantidad_dispensada,
        c.fecha_dispensacion,
        c.contrato,
        c.regimen,
        p.cum,
        p.consecutivo_cum,
        p.registro_invima,
        p.principio_activo,
        p.concentracion,
        p.unidad_medida,
        p.precio_venta,
        ff.nombre AS forma_farmaceutica,
        ROUND(c.cantidad_dispensada * COALESCE(p.precio_venta, 0), 2) AS valor_total,
        sedref.nombre AS sede
     FROM dispensacion_hs_control c
     LEFT JOIN productos p ON p.id_producto = c.id_producto
     LEFT JOIN formas_farmaceuticas ff ON ff.id_forma = p.id_forma
     LEFT JOIN (
       SELECT m1.referencia_id, m1.id_almacen_origen
       FROM movimientos_inventario m1
       INNER JOIN (
         SELECT referencia_id, MAX(fecha_hora) AS max_fecha
         FROM movimientos_inventario
         WHERE referencia_tipo = 'DISPENSACION_HS_CONTROL'
         GROUP BY referencia_id
       ) mx ON mx.referencia_id = m1.referencia_id AND mx.max_fecha = m1.fecha_hora
       WHERE m1.referencia_tipo = 'DISPENSACION_HS_CONTROL'
       GROUP BY m1.referencia_id, m1.id_almacen_origen
     ) movref_almacen ON movref_almacen.referencia_id = c.id
     LEFT JOIN almacenes almref ON almref.id_almacen = movref_almacen.id_almacen_origen
     LEFT JOIN sedes sedref ON sedref.id_sede = almref.id_sede
     ${where}
     ORDER BY c.fecha_dispensacion DESC`,
    params
  );

  // El CIE-10 solo existe en HealthSphere (texto libre "CODIGO-Descripción"
  // en fm.dx), nunca localmente — se trae en un segundo viaje (bases
  // distintas, no se puede hacer JOIN directo) y se cruza por
  // id_med_formulacion_hs, la misma clave que usa getHistorialEntregas().
  const [dxPorId, prescriptorPorFormulacion] = await Promise.all([
    getDxPorIdMedFormulacion(rows.map((r) => r.id_med_formulacion_hs)),
    getPrescriptorPorIdFormulacion(rows.map((r) => r.id_formulacion_hs))
  ]);
  const rowsConDx = rows.map((row) => {
    const dx = dxPorId[row.id_med_formulacion_hs];
    const prescriptor = prescriptorPorFormulacion[row.id_formulacion_hs];
    return {
      ...row,
      // El médico prescriptor es el mismo para todos los medicamentos de
      // una misma fórmula (se resuelve por id_formulacion_hs, no por
      // id_med_formulacion_hs) — null cuando la formulación no tiene
      // especialista enlazado en HS (formulaciones antiguas).
      tipo_documento_medico: prescriptor?.tipo_documento_medico ?? null,
      numero_documento_medico: prescriptor?.numero_documento_medico ?? null,
      // Por ahora no existe código de habilitación (REPS) capturado en el
      // sistema — a pedido explícito, este campo lleva el NOMBRE de la sede
      // donde se dispensó mientras se carga ese dato real.
      codigo_habilitacion: row.sede ?? null,
      diagnostico_cie10: dx?.cie10 ?? null,
      diagnostico_texto: dx?.dx_completo ?? null,
      // "Tipo de medicamento": todavía no hay fuente de datos para esto
      // (ni local ni en HS) — el usuario pidió dejarlo vacío por ahora en
      // vez de inventar un valor.
      tipo_medicamento: null,
      // CUM con su consecutivo, del Maestro LOCAL (no de HS) — formato
      // "19963298-2", tal como se ve en la ficha del MX.
      cum_completo: row.cum ? `${row.cum}${row.consecutivo_cum != null ? `-${row.consecutivo_cum}` : ''}` : null,
      // Descripción del producto = el nombre EXACTO con el que HealthSphere
      // formuló (c.nombre_medicamento, ya viene de fm.medicamento), no el
      // nombre_comercial del Maestro local — pueden ser distintos.
      descripcion_producto: row.nombre_medicamento,
      // Concentración de HealthSphere (suhc_new_tbl_medicine.concentracion),
      // no la del Maestro local.
      concentracion_hs: dx?.concentracion_hs ?? null,
      // Corregido a pedido explícito: "Unidad de medida" debe ser la MISMA
      // que aparece en la ficha del MX en Maestro (productos.unidad_medida,
      // local) — no la unidad de dosificación de HealthSphere. Esa sigue
      // usándose, pero solo para "Unidad mínima de dispensación" más abajo.
      unidad_medida: row.unidad_medida ?? null,
      forma_farmaceutica_hs: dx?.forma_farmaceutica_hs ?? null,
      unidad_minima_dispensacion: dx?.unidad_minima_dispensacion ?? null,
      // Cantidad dispensada REAL (local, neta de anulaciones) — no la
      // formulada. Ya existía como cantidad_dispensada; se expone también
      // con este nombre para que coincida con la variable del RIPS.
      cantidad_dispensada_rips: row.cantidad_dispensada,
      temporalidad_hs: dx?.temporalidad_hs ?? null
    };
  });

  return { filter, rows: rowsConDx };
}

function buildRipsAmReport(filter, rows) {
  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary: {
      registros: rows.length,
      sin_cie10: countWhere(rows, (row) => !row.diagnostico_cie10),
      sin_codigo_habilitacion: countWhere(rows, (row) => !row.codigo_habilitacion),
      sin_medico_prescriptor: countWhere(rows, (row) => !row.numero_documento_medico)
    },
    // El dataset completo (paciente, CUM, medicamento, etc.) se sigue
    // trayendo y queda disponible internamente para cuando se agreguen las
    // siguientes variables — pero SOLO se exponen en el archivo las que el
    // usuario ya confirmó, para no entregar columnas no solicitadas.
    rows
  };
}

// Únicamente las 3 variables confirmadas hasta ahora (código habilitación,
// fecha dispensación, CIE-10). Cuando lleguen las siguientes, se agregan
// aquí en el orden que se indique — el resto del dataset ya está disponible
// en `rows`, solo falta exponerlo.
const RIPS_AM_COLUMNS = [
  { key: 'codigo_habilitacion', label: 'Código habilitación (sede)', width: 160, type: 'string' },
  { key: 'fecha_dispensacion', label: 'Fecha dispensación', width: 130, type: 'string' },
  { key: 'diagnostico_cie10', label: 'CIE-10', width: 90, type: 'string' },
  { key: 'tipo_medicamento', label: 'Tipo de medicamento', width: 110, type: 'string' },
  { key: 'cum_completo', label: 'CUM', width: 110, type: 'string' },
  { key: 'descripcion_producto', label: 'Descripción del producto', width: 260, type: 'string' },
  { key: 'concentracion_hs', label: 'Concentración', width: 110, type: 'string' },
  { key: 'unidad_medida', label: 'Unidad de medida', width: 100, type: 'string' },
  { key: 'forma_farmaceutica_hs', label: 'Forma farmacéutica', width: 130, type: 'string' },
  { key: 'unidad_minima_dispensacion', label: 'Unidad mínima de dispensación', width: 140, type: 'string' },
  { key: 'cantidad_dispensada_rips', label: 'Cantidad dispensada', width: 100, type: 'number' },
  { key: 'temporalidad_hs', label: 'Temporalidad (días de tratamiento)', width: 150, type: 'string' },
  { key: 'tipo_documento_medico', label: 'Tipo de documento médico prescriptor', width: 140, type: 'string' },
  { key: 'numero_documento_medico', label: 'Número de documento médico prescriptor', width: 140, type: 'string' }
];

function ripsAmSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'ADVERTENCIA', valor: 'Solo se incluyen las variables confirmadas hasta ahora (código habilitación, fecha dispensación, CIE-10). Faltan las siguientes por homologar.' },
    { metrica: 'Registros', valor: data.summary.registros },
    { metrica: 'Registros sin diagnóstico CIE-10', valor: data.summary.sin_cie10 },
    { metrica: 'Registros sin código de habilitación (sede)', valor: data.summary.sin_codigo_habilitacion },
    { metrica: 'Registros sin médico prescriptor enlazado en HS', valor: data.summary.sin_medico_prescriptor }
  ];
}

function buildRipsAmExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 260, type: 'string' },
        { key: 'valor', label: 'Valor', width: 200, type: 'string' }
      ],
      rows: ripsAmSummaryRows(data)
    },
    {
      name: 'AM_Medicamentos',
      columns: RIPS_AM_COLUMNS,
      rows: data.rows
    }
  ]);
}

function buildRipsAmPdf(data) {
  const lines = [];
  lines.push(...ripsAmSummaryRows(data).map((row) => `${pad(row.metrica, 40)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'AM - MEDICAMENTOS (RIPS)');
  lines.push(...tableLines([
    { key: 'codigo_habilitacion', label: 'COD HABILITACION', width: 20 },
    { key: 'fecha_dispensacion', label: 'FECHA DISPENSACION', width: 18 },
    { key: 'diagnostico_cie10', label: 'CIE10', width: 8 },
    { key: 'cum_completo', label: 'CUM', width: 14 },
    { key: 'descripcion_producto', label: 'PRODUCTO', width: 28 },
    { key: 'concentracion_hs', label: 'CONCENTRACION', width: 14 },
    { key: 'unidad_minima_dispensacion', label: 'UNID MINIMA', width: 12 },
    { key: 'cantidad_dispensada_rips', label: 'CANT', width: 6, align: 'right' },
    { key: 'temporalidad_hs', label: 'TEMPORALIDAD', width: 14 },
    { key: 'tipo_documento_medico', label: 'TIPO DOC MEDICO', width: 12 },
    { key: 'numero_documento_medico', label: 'NUM DOC MEDICO', width: 14 }
  ], data.rows));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - RIPS ARCHIVO AM (MEDICAMENTOS)',
    subtitle: `Generado: ${data.generatedAt} — solo variables confirmadas hasta ahora`,
    lines,
    landscape: true
  });
}

export async function createRipsAmExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchRipsAmDataset(params);
  const data = buildRipsAmReport(dataset.filter, dataset.rows);
  const fileBase = `akripharmacy-rips-am-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'RIPS_AM',
    descripcion: `Exportación de RIPS (archivo AM) en formato ${normalizedFormat} — estructura estándar pendiente de homologación`,
    userId,
    excelBuilder: buildRipsAmExcel,
    pdfBuilder: buildRipsAmPdf
  });
}

// Informe "Pendientes (generados y pagados)": el sistema HOY no tiene
// ningún concepto de "pagado" (ni tabla de pagos/cartera, ni estado de
// factura pagada — el ciclo de vida de `facturas.estado` termina en
// aceptada/rechazada frente a SIESA). Por decisión explícita, este informe
// solo cubre la mitad real de "generados": las facturas emitidas y su
// estado actual. La columna de pago queda documentada como pendiente hasta
// que exista esa fuente de datos.
async function fetchPendientesDataset({ search = '', desde = null, hasta = null, idSede = null } = {}) {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;

  const conditions = [];
  const params = [];
  if (filter) {
    conditions.push(`(f.numero_completo LIKE ? OR v.folio_venta LIKE ?)`);
    params.push(wildcard, wildcard);
  }
  if (desde) {
    conditions.push('f.fecha_emision >= ?');
    params.push(`${desde} 00:00:00`);
  }
  if (hasta) {
    conditions.push('f.fecha_emision <= ?');
    params.push(`${hasta} 23:59:59`);
  }
  if (idSede) {
    conditions.push('v.id_sede = ?');
    params.push(idSede);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query(
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
        v.metodo_pago,
        s.nombre AS sede
     FROM facturas f
     INNER JOIN ventas v ON v.id_venta = f.id_venta
     LEFT JOIN sedes s ON s.id_sede = v.id_sede
     ${where}
     ORDER BY f.fecha_emision DESC`,
    params
  );

  return { filter, rows };
}

function buildPendientesReport(filter, rows) {
  return {
    generatedAt: new Date().toISOString(),
    filter,
    summary: {
      facturas: rows.length,
      borrador: countWhere(rows, (row) => row.estado === 'borrador'),
      emitida: countWhere(rows, (row) => row.estado === 'emitida'),
      enviada_siesa: countWhere(rows, (row) => row.estado === 'enviada_siesa'),
      aceptada: countWhere(rows, (row) => row.estado === 'aceptada'),
      rechazada: countWhere(rows, (row) => row.estado === 'rechazada'),
      valor_total: Number(rows.reduce((sum, row) => sum + toNumber(row.total), 0).toFixed(2))
    },
    rows
  };
}

function pendientesSummaryRows(data) {
  return [
    { metrica: 'Fecha de generación', valor: data.generatedAt },
    { metrica: 'Filtro aplicado', valor: data.filter || 'Sin filtro' },
    { metrica: 'ADVERTENCIA', valor: 'El sistema aún no registra pagos — este informe solo cubre facturas GENERADAS y su estado. La columna "pagado" no existe todavía.' },
    { metrica: 'Facturas generadas', valor: data.summary.facturas },
    { metrica: 'En borrador', valor: data.summary.borrador },
    { metrica: 'Emitidas', valor: data.summary.emitida },
    { metrica: 'Enviadas a SIESA', valor: data.summary.enviada_siesa },
    { metrica: 'Aceptadas', valor: data.summary.aceptada },
    { metrica: 'Rechazadas', valor: data.summary.rechazada },
    { metrica: 'Valor total generado', valor: data.summary.valor_total }
  ];
}

function buildPendientesExcel(data) {
  return buildExcelWorkbook([
    {
      name: 'Resumen',
      columns: [
        { key: 'metrica', label: 'Métrica', width: 260, type: 'string' },
        { key: 'valor', label: 'Valor', width: 200, type: 'string' }
      ],
      rows: pendientesSummaryRows(data)
    },
    {
      name: 'FacturasGeneradas',
      columns: [
        { key: 'numero_completo', label: 'Número factura', width: 110, type: 'string' },
        { key: 'folio_venta', label: 'Venta', width: 100, type: 'string' },
        { key: 'fecha_emision', label: 'Fecha emisión', width: 130, type: 'string' },
        { key: 'estado', label: 'Estado', width: 110, type: 'string' },
        { key: 'sede', label: 'Sede', width: 120, type: 'string' },
        { key: 'metodo_pago', label: 'Método de pago', width: 110, type: 'string' },
        { key: 'subtotal', label: 'Subtotal', width: 90, type: 'number' },
        { key: 'impuestos', label: 'Impuestos', width: 90, type: 'number' },
        { key: 'total', label: 'Total', width: 90, type: 'number' },
        { key: 'moneda', label: 'Moneda', width: 70, type: 'string' }
      ],
      rows: data.rows
    }
  ]);
}

function buildPendientesPdf(data) {
  const lines = [];
  lines.push(...pendientesSummaryRows(data).map((row) => `${pad(row.metrica, 40)} : ${asciiSafe(row.valor)}`));
  lines.push('', 'FACTURAS GENERADAS');
  lines.push(...tableLines([
    { key: 'numero_completo', label: 'FACTURA', width: 14 },
    { key: 'fecha_emision', label: 'FECHA', width: 18 },
    { key: 'estado', label: 'ESTADO', width: 16 },
    { key: 'total', label: 'TOTAL', width: 12, align: 'right' }
  ], data.rows));

  return buildPdfDocument({
    title: 'AKRIPHARMACY - PENDIENTES (FACTURAS GENERADAS)',
    subtitle: `Generado: ${data.generatedAt} — no incluye pagos (sin fuente de datos aún)`,
    lines,
    landscape: true
  });
}

export async function createPendientesExport(format, params = {}, userId = null) {
  const normalizedFormat = normalizeFormat(format);
  const dataset = await fetchPendientesDataset(params);
  const data = buildPendientesReport(dataset.filter, dataset.rows);
  const fileBase = `akripharmacy-pendientes-${timestampForFile()}`;

  return finalizeExport({
    normalizedFormat,
    fileBase,
    data,
    submodulo: 'PENDIENTES',
    descripcion: `Exportación de pendientes (facturas generadas) en formato ${normalizedFormat}`,
    userId,
    excelBuilder: buildPendientesExcel,
    pdfBuilder: buildPendientesPdf
  });
}
