import axios from 'axios';
import { query } from '../config/db.js';
import { env } from '../config/env.js';
import { getInvoiceById } from './billing.service.js';
import { HttpError } from '../utils/http-error.js';

export async function getSiesaConfig() {
  const rows = await query(
    `SELECT * FROM integracion_siesa_config WHERE es_activo = TRUE ORDER BY id_config DESC LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function upsertSiesaConfig(payload) {
  const current = await getSiesaConfig();

  if (!current) {
    const result = await query(
      `INSERT INTO integracion_siesa_config (
        nombre, api_base_url, auth_url, invoice_endpoint, client_id, client_secret,
        company_id, ambiente, timeout_ms, headers_extra, es_activo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [
        payload.nombre ?? 'SIESA Default',
        payload.api_base_url ?? null,
        payload.auth_url ?? null,
        payload.invoice_endpoint ?? '/invoices',
        payload.client_id ?? null,
        payload.client_secret ?? null,
        payload.company_id ?? null,
        payload.ambiente ?? 'sandbox',
        payload.timeout_ms ?? env.SIESA_TIMEOUT_MS,
        JSON.stringify(payload.headers_extra ?? {})
      ]
    );
    const rows = await query(
      `SELECT * FROM integracion_siesa_config WHERE id_config = ?`,
      [result.insertId]
    );
    return rows[0];
  }

  await query(
    `UPDATE integracion_siesa_config SET
      nombre = ?,
      api_base_url = ?,
      auth_url = ?,
      invoice_endpoint = ?,
      client_id = ?,
      client_secret = ?,
      company_id = ?,
      ambiente = ?,
      timeout_ms = ?,
      headers_extra = ?,
      es_activo = TRUE
     WHERE id_config = ?`,
    [
      payload.nombre ?? current.nombre,
      payload.api_base_url ?? current.api_base_url,
      payload.auth_url ?? current.auth_url,
      payload.invoice_endpoint ?? current.invoice_endpoint,
      payload.client_id ?? current.client_id,
      payload.client_secret ?? current.client_secret,
      payload.company_id ?? current.company_id,
      payload.ambiente ?? current.ambiente,
      payload.timeout_ms ?? current.timeout_ms,
      JSON.stringify(payload.headers_extra ?? (current.headers_extra ?? {})),
      current.id_config
    ]
  );

  return getSiesaConfig();
}

async function logSiesaRequest({ idFactura, endpoint, metodo, requestPayload, responsePayload, estadoHttp, exito, mensajeError }) {
  await query(
    `INSERT INTO integracion_siesa_logs (
      id_factura, endpoint, metodo, request_payload, response_payload, estado_http, exito, mensaje_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      idFactura ?? null,
      endpoint,
      metodo,
      requestPayload ? JSON.stringify(requestPayload) : null,
      responsePayload ? JSON.stringify(responsePayload) : null,
      estadoHttp ?? null,
      exito ?? false,
      mensajeError ?? null
    ]
  );
}

function buildPayload(invoice) {
  return {
    document: {
      prefix: invoice.prefijo,
      number: invoice.consecutivo,
      date: String(invoice.fecha_emision).slice(0, 10),
      currency: invoice.moneda
    },
    customer: {
      code: invoice.id_venta,
      name: 'Cliente ERP'
    },
    items: invoice.details.map((detail) => ({
      sku: detail.id_producto,
      description: detail.descripcion,
      quantity: detail.cantidad,
      unitPrice: detail.precio_unitario,
      taxValue: detail.impuesto,
      totalLine: detail.total_linea
    })),
    totals: {
      subtotal: invoice.subtotal,
      taxes: invoice.impuestos,
      total: invoice.total
    },
    meta: {
      source: 'AkriPharmacy',
      invoiceId: invoice.id_factura,
      saleId: invoice.id_venta
    }
  };
}

export async function submitInvoiceToSiesa(idFactura) {
  const invoice = await getInvoiceById(idFactura);
  const config = await getSiesaConfig();

  if (!config) {
    throw new HttpError(400, 'No existe configuración activa de SIESA');
  }

  const payload = buildPayload(invoice);

  if (env.SIESA_MOCK_MODE || !config.api_base_url) {
    const mockResponse = {
      success: true,
      provider: 'SIESA-MOCK',
      status: 'accepted',
      externalId: `SIESA-MOCK-${invoice.id_factura}`,
      receivedAt: new Date().toISOString()
    };

    await query(
      `UPDATE facturas
       SET estado = 'aceptada', respuesta_siesa = ?
       WHERE id_factura = ?`,
      [JSON.stringify(mockResponse), idFactura]
    );

    await logSiesaRequest({
      idFactura,
      endpoint: config.invoice_endpoint,
      metodo: 'POST',
      requestPayload: payload,
      responsePayload: mockResponse,
      estadoHttp: 200,
      exito: true
    });

    return mockResponse;
  }

  const endpoint = `${config.api_base_url}${config.invoice_endpoint}`;
  const headersExtra = typeof config.headers_extra === 'string'
    ? JSON.parse(config.headers_extra)
    : (config.headers_extra ?? {});

  try {
    const response = await axios.post(endpoint, payload, {
      timeout: config.timeout_ms ?? env.SIESA_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-Company-Id': config.company_id ?? '',
        'X-Client-Id': config.client_id ?? '',
        ...(headersExtra || {})
      },
      auth: config.client_id && config.client_secret
        ? { username: config.client_id, password: config.client_secret }
        : undefined
    });

    await query(
      `UPDATE facturas
       SET estado = ?, respuesta_siesa = ?
       WHERE id_factura = ?`,
      [
        response.status >= 200 && response.status < 300 ? 'aceptada' : 'rechazada',
        JSON.stringify(response.data),
        idFactura
      ]
    );

    await logSiesaRequest({
      idFactura,
      endpoint,
      metodo: 'POST',
      requestPayload: payload,
      responsePayload: response.data,
      estadoHttp: response.status,
      exito: response.status >= 200 && response.status < 300
    });

    return response.data;
  } catch (error) {
    const status = error.response?.status ?? 500;
    const data = error.response?.data ?? { message: error.message };

    await query(
      `UPDATE facturas
       SET estado = 'rechazada', respuesta_siesa = ?
       WHERE id_factura = ?`,
      [JSON.stringify(data), idFactura]
    );

    await logSiesaRequest({
      idFactura,
      endpoint,
      metodo: 'POST',
      requestPayload: payload,
      responsePayload: data,
      estadoHttp: status,
      exito: false,
      mensajeError: error.message
    });

    throw new HttpError(status, 'Error al enviar factura a SIESA', data);
  }
}
