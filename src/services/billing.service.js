import { query, withTransaction } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';

export async function listInvoices() {
  return query(
    `SELECT
        f.*,
        v.folio_venta
     FROM facturas f
     INNER JOIN ventas v ON v.id_venta = f.id_venta
     ORDER BY f.id_factura DESC`
  );
}

export async function createInvoiceFromSale(idVenta) {
  return withTransaction(async (connection) => {
    const [saleRows] = await connection.execute(
      `SELECT * FROM ventas WHERE id_venta = ? FOR UPDATE`,
      [idVenta]
    );
    const sale = saleRows[0];

    if (!sale) {
      throw new HttpError(404, 'Venta no encontrada');
    }

    const [existingInvoiceRows] = await connection.execute(
      `SELECT * FROM facturas WHERE id_venta = ?`,
      [idVenta]
    );

    if (existingInvoiceRows[0]) {
      return existingInvoiceRows[0];
    }

    const [counterRows] = await connection.execute(
      `SELECT COALESCE(MAX(consecutivo), 0) + 1 AS nextConsecutivo FROM facturas WHERE prefijo = 'AK'`
    );
    const consecutivo = counterRows[0].nextConsecutivo;

    const [invoiceResult] = await connection.execute(
      `INSERT INTO facturas (
        id_venta, prefijo, consecutivo, estado, moneda, subtotal, impuestos, total
      ) VALUES (?, 'AK', ?, 'emitida', 'COP', ?, ?, ?)`,
      [idVenta, consecutivo, sale.subtotal, sale.impuestos, sale.total]
    );

    const [saleDetailRows] = await connection.execute(
      `SELECT
          vd.*,
          p.nombre_comercial
       FROM ventas_detalle vd
       INNER JOIN productos p ON p.id_producto = vd.id_producto
       WHERE vd.id_venta = ?`,
      [idVenta]
    );

    for (const detail of saleDetailRows) {
      const totalLinea = (Number(detail.cantidad) * Number(detail.precio_unitario))
        - Number(detail.descuento ?? 0)
        + Number(detail.impuesto ?? 0);

      await connection.execute(
        `INSERT INTO facturas_detalle (
          id_factura, id_producto, descripcion, cantidad, precio_unitario, impuesto, total_linea
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceResult.insertId,
          detail.id_producto,
          detail.nombre_comercial,
          detail.cantidad,
          detail.precio_unitario,
          detail.impuesto,
          totalLinea
        ]
      );
    }

    await connection.execute(
      `UPDATE ventas SET estado = 'facturada' WHERE id_venta = ?`,
      [idVenta]
    );

    const [invoiceRows] = await connection.execute(
      `SELECT * FROM facturas WHERE id_factura = ?`,
      [invoiceResult.insertId]
    );

    return invoiceRows[0];
  });
}

export async function getInvoiceById(idFactura) {
  const rows = await query(
    `SELECT * FROM facturas WHERE id_factura = ?`,
    [idFactura]
  );
  const invoice = rows[0];

  if (!invoice) {
    throw new HttpError(404, 'Factura no encontrada');
  }

  const details = await query(
    `SELECT * FROM facturas_detalle WHERE id_factura = ?`,
    [idFactura]
  );

  return {
    ...invoice,
    details
  };
}
