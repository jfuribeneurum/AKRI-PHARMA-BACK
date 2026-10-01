import { query, withTransaction } from '../config/db.js';
import { getFormulacionHSById, getPrescriptorPorIdFormulacion, getDxPorIdMedFormulacion, getTipoDocumentoPacientePorId } from './formulacion-hs.service.js';
import { HttpError } from '../utils/http-error.js';
import { recordProcessTrace } from './traceability.service.js';
import { crearFacturaSalud, obtenerDocumentosSalud, crearNotaCreditoSalud, crearNotaDebitoSalud } from './akribeia.service.js';

const TIPO_MEDICAMENTO_PBS = '01';
const TIPO_MEDICAMENTO_NO_PBS = '02';

export async function getControlByFormulacion(idFormulacion) {
  return query(
    `SELECT id, id_formulacion_hs, id_med_formulacion_hs, nombre_medicamento,
            cantidad_formulada, cantidad_dispensada, estado,
            fecha_formulacion, fecha_dispensacion, observaciones, id_producto,
            contrato, regimen
       FROM dispensacion_hs_control
      WHERE id_formulacion_hs = ?
      ORDER BY id ASC`,
    [idFormulacion]
  );
}

export async function getControlStatusBatch(idFormulaciones) {
  if (!idFormulaciones.length) return [];
  const placeholders = idFormulaciones.map(() => '?').join(',');
  return query(
    `SELECT id_formulacion_hs,
            SUM(cantidad_formulada)      AS total_formulado,
            SUM(cantidad_dispensada)     AS total_dispensado,
            SUM(estado = 'pendiente')    AS pendientes,
            SUM(estado = 'dispensado')   AS dispensados,
            SUM(estado = 'parcial')      AS parciales,
            SUM(estado = 'cancelado')    AS cancelados,
            MAX(fecha_dispensacion)      AS ultima_fecha_dispensacion
       FROM dispensacion_hs_control
      WHERE id_formulacion_hs IN (${placeholders})
      GROUP BY id_formulacion_hs`,
    idFormulaciones
  );
}

export async function listDispensacionesHS({ search = '', estado = '', page = 1, limit = 50 } = {}) {
  const offset    = (Math.max(1, page) - 1) * limit;
  const wild      = `%${search.trim()}%`;
  const hasSearch = search.trim() !== '';
  const hasEstado = estado.trim() !== '';

  const conditions = [];
  const params     = [];

  if (hasSearch) {
    conditions.push(`(nombre_paciente LIKE ? OR documento_paciente LIKE ? OR nombre_medicamento LIKE ?)`);
    params.push(wild, wild, wild);
  }
  if (hasEstado) {
    conditions.push(`estado = ?`);
    params.push(estado);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  return query(
    `SELECT id, id_formulacion_hs, id_med_formulacion_hs, id_paciente_hs,
            nombre_paciente, documento_paciente, nombre_medicamento, presentacion,
            cantidad_formulada, cantidad_dispensada, estado,
            fecha_formulacion, fecha_dispensacion, observaciones, id_producto,
            contrato, regimen, fecha_creacion
       FROM dispensacion_hs_control
       ${whereClause}
      ORDER BY fecha_creacion DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
}

// Historial de entregas reales (append-only) de una formulación completa.
// dispensacion_hs_control guarda un único acumulado por medicamento — el
// detalle de cada entrega ya queda en movimientos_inventario (uno por lote
// usado), referenciado por 'DISPENSACION_HS_CONTROL' + el id de control.
export async function getHistorialEntregas(idFormulacionHs) {
  const controles = await query(
    `SELECT id, id_med_formulacion_hs, nombre_medicamento
       FROM dispensacion_hs_control
      WHERE id_formulacion_hs = ?`,
    [idFormulacionHs]
  );
  if (!controles.length) return [];

  const nombrePorControl = Object.fromEntries(controles.map(c => [c.id, c.nombre_medicamento]));
  const idMedFormPorControl = Object.fromEntries(controles.map(c => [c.id, c.id_med_formulacion_hs]));
  const idsControl = controles.map(c => c.id);
  const placeholders = idsControl.map(() => '?').join(',');

  const movimientos = await query(
    `SELECT m.id_movimiento, m.referencia_id, m.fecha_hora, m.cantidad,
            l.numero_lote, a.nombre AS almacen, u.nombre_completo AS usuario
       FROM movimientos_inventario m
       LEFT JOIN lotes l      ON l.id_lote = m.id_lote
       LEFT JOIN almacenes a  ON a.id_almacen = m.id_almacen_origen
       LEFT JOIN usuarios u   ON u.id_usuario = m.id_usuario
      WHERE m.referencia_tipo = 'DISPENSACION_HS_CONTROL'
        AND m.referencia_id IN (${placeholders})
      ORDER BY m.fecha_hora DESC`,
    idsControl
  );
  if (!movimientos.length) return [];

  // Una entrega anulada (ver anularEntregaHS) ya no cuenta como real para el
  // cálculo de pendientes, pero se mantiene visible en el histórico marcada
  // como "anulado" para conservar la trazabilidad completa.
  const idsMovimientos = movimientos.map(m => m.id_movimiento);
  const placeholdersMov = idsMovimientos.map(() => '?').join(',');
  const anulaciones = await query(
    `SELECT referencia_id FROM movimientos_inventario
      WHERE referencia_tipo = 'ANULACION_DISPENSACION_HS' AND referencia_id IN (${placeholdersMov})`,
    idsMovimientos
  );
  const anuladosSet = new Set(anulaciones.map(a => Number(a.referencia_id)));

  return movimientos.map(m => ({
    ...m,
    nombre_medicamento: nombrePorControl[m.referencia_id] ?? null,
    id_med_formulacion_hs: idMedFormPorControl[m.referencia_id] ?? null,
    anulado: anuladosSet.has(Number(m.id_movimiento))
  }));
}

// Anula una entrega puntual del histórico (un movimiento_inventario de tipo
// DISPENSACION_HS_CONTROL): repone el inventario que había salido, revierte
// el renglón de controlados_libro si aplica, resta lo anulado del acumulado
// cacheado en dispensacion_hs_control (vuelve a quedar pendiente) y deja
// trazabilidad de qué usuario lo hizo. El movimiento original NUNCA se borra
// ni se modifica (el ledger es append-only) — se inserta un movimiento de
// reversión que referencia al original.
export async function anularEntregaHS(idMovimiento, userId, idSede = null) {
  return withTransaction(async (connection) => {
    const [movRows] = await connection.execute(
      `SELECT * FROM movimientos_inventario WHERE id_movimiento = ? AND referencia_tipo = 'DISPENSACION_HS_CONTROL' FOR UPDATE`,
      [idMovimiento]
    );
    const movimiento = movRows[0];
    if (!movimiento) {
      throw new HttpError(404, 'Entrega no encontrada');
    }

    const [yaAnuladoRows] = await connection.execute(
      `SELECT id_movimiento FROM movimientos_inventario
        WHERE referencia_tipo = 'ANULACION_DISPENSACION_HS' AND referencia_id = ?`,
      [idMovimiento]
    );
    if (yaAnuladoRows.length) {
      throw new HttpError(400, 'Esta entrega ya fue anulada.');
    }

    const idControl = movimiento.referencia_id;
    const [controlRows] = await connection.execute(
      `SELECT id, cantidad_formulada, cantidad_dispensada FROM dispensacion_hs_control WHERE id = ? FOR UPDATE`,
      [idControl]
    );
    const control = controlRows[0];
    if (!control) {
      throw new HttpError(404, 'Registro de control no encontrado');
    }

    const [existRows] = await connection.execute(
      `SELECT id_existencia, cantidad_disponible FROM existencias WHERE id_lote = ? AND id_ubicacion = ? FOR UPDATE`,
      [movimiento.id_lote, movimiento.id_ubicacion_origen]
    );
    const existencia = existRows[0];
    if (!existencia) {
      throw new HttpError(404, 'No se encontró la existencia original para reponer el inventario.');
    }

    const saldoAnterior = Number(existencia.cantidad_disponible);
    const saldoNuevo = saldoAnterior + Number(movimiento.cantidad);

    await connection.execute(
      `UPDATE existencias SET cantidad_disponible = ? WHERE id_existencia = ?`,
      [saldoNuevo, existencia.id_existencia]
    );

    await connection.execute(
      `INSERT INTO movimientos_inventario (
         tipo, id_producto, id_lote, id_almacen_destino, id_ubicacion_destino,
         cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
       ) VALUES ('devolucion_venta', ?, ?, ?, ?, ?, ?, ?, 'ANULACION_DISPENSACION_HS', ?, ?)`,
      [
        movimiento.id_producto, movimiento.id_lote,
        movimiento.id_almacen_origen, movimiento.id_ubicacion_origen,
        movimiento.cantidad, movimiento.costo_unitario,
        'Anulación de entrega de dispensación HS', idMovimiento, userId ?? null
      ]
    );

    const [prodRows] = await connection.execute(
      `SELECT es_controlado FROM productos WHERE id_producto = ?`,
      [movimiento.id_producto]
    );
    if (prodRows[0]?.es_controlado) {
      await connection.execute(
        `INSERT INTO controlados_libro (
           tipo_movimiento, id_producto, id_lote, cantidad, saldo_anterior, saldo_nuevo,
           referencia_tipo, referencia_id, usuario_responsable, observaciones
         ) VALUES ('entrada', ?, ?, ?, ?, ?, 'ANULACION_DISPENSACION_HS', ?, ?, ?)`,
        [
          movimiento.id_producto, movimiento.id_lote, movimiento.cantidad,
          saldoAnterior, saldoNuevo, idMovimiento, userId ?? null,
          'Reingreso por anulación de entrega'
        ]
      );
    }

    const nuevoTotal = Math.max(0, Number(control.cantidad_dispensada) - Number(movimiento.cantidad));
    let nuevoEstado = 'parcial';
    if (nuevoTotal === 0) nuevoEstado = 'pendiente';
    else if (nuevoTotal >= Number(control.cantidad_formulada)) nuevoEstado = 'dispensado';

    await connection.execute(
      `UPDATE dispensacion_hs_control SET cantidad_dispensada = ?, estado = ? WHERE id = ?`,
      [nuevoTotal, nuevoEstado, idControl]
    );

    await recordProcessTrace(connection, {
      proceso: 'DISPENSACION',
      subproceso: 'ANULAR_ENTREGA_HS',
      id_sede: idSede,
      id_usuario: userId ?? null,
      referencia_tipo: 'DISPENSACION_HS_CONTROL',
      referencia_id: idControl,
      descripcion: `Anulación de entrega de ${movimiento.cantidad} unidad(es) (movimiento #${idMovimiento}) — la cantidad vuelve a quedar pendiente`,
      payload_json: {
        id_movimiento_anulado: idMovimiento,
        id_lote: movimiento.id_lote,
        cantidad_repuesta: Number(movimiento.cantidad),
        cantidad_dispensada_antes: Number(control.cantidad_dispensada),
        cantidad_dispensada_despues: nuevoTotal
      }
    });

    return {
      id_movimiento: idMovimiento,
      cantidad_repuesta: Number(movimiento.cantidad),
      cantidad_dispensada: nuevoTotal,
      estado: nuevoEstado
    };
  });
}

export async function dispensarMedicamento(payload, userId, idSede = null) {
  const { id_formulacion_hs, id_med_formulacion_hs } = payload;

  const formulacion = await getFormulacionHSById(id_formulacion_hs, idSede);
  if (!formulacion) {
    throw new HttpError(404, 'Formulación no encontrada en HealthSphere');
  }

  const med = formulacion.medicamentos.find(m => m.id_med_formulacion === id_med_formulacion_hs);
  if (!med) {
    throw new HttpError(404, 'Medicamento no encontrado en la formulación');
  }

  const cantidadDispensada = Number(payload.cantidad_dispensada ?? med.cantidad);
  const cantidadFormulada  = Number(med.cantidad);
  // Primera dispensación de este medicamento: si viene un acumulado manual,
  // ese es el valor real que queda guardado (no el delta de "control de entrega").
  const cantidadInicial = payload.cantidad_dispensada_total_override != null
    ? Number(payload.cantidad_dispensada_total_override)
    : cantidadDispensada;
  let estado = 'dispensado';
  if (cantidadInicial === 0) estado = 'pendiente';
  else if (cantidadInicial < cantidadFormulada) estado = 'parcial';

  // "Control de entrega" (cantidad_dispensada) es lo que realmente sale del
  // inventario ahora mismo, así que exige saber de qué lote(s) sale.
  const lotes = Array.isArray(payload.lotes) ? payload.lotes : [];
  if (cantidadDispensada > 0) {
    if (!lotes.length) {
      throw new HttpError(400, 'Debes elegir de qué lote(s) sale la cantidad a entregar.');
    }
    const totalLotes = lotes.reduce((sum, l) => sum + Number(l.cantidad), 0);
    if (totalLotes !== cantidadDispensada) {
      throw new HttpError(400,
        `La suma de los lotes elegidos (${totalLotes}) no coincide con la cantidad a entregar (${cantidadDispensada}).`
      );
    }
  }

  const nombrePaciente = (formulacion.nombre_paciente ?? '').trim();
  const fechaFormulacion = formulacion.fechaFormulacion instanceof Date
    ? formulacion.fechaFormulacion.toISOString().slice(0, 10)
    : String(formulacion.fechaFormulacion ?? '').slice(0, 10);

  return withTransaction(async (connection) => {
    // FOR UPDATE: dos guardados casi simultáneos del mismo medicamento (dos
    // pestañas, o rondas seguidas antes de que refresque la anterior) no deben
    // poder leer el mismo cantidad_dispensada y pisarse el uno al otro al
    // escribir — el segundo debe esperar y partir del total ya actualizado.
    const [existingRows] = await connection.execute(
      `SELECT id FROM dispensacion_hs_control WHERE id_formulacion_hs = ? AND id_med_formulacion_hs = ? LIMIT 1 FOR UPDATE`,
      [id_formulacion_hs, id_med_formulacion_hs]
    );
    const esNuevo = existingRows.length === 0;
    const tieneOverride = payload.cantidad_dispensada_total_override != null;

    let idControl;
    let nuevoEstado;

    if (!esNuevo) {
      idControl = existingRows[0].id;
      const [currentRows] = await connection.execute(
        `SELECT cantidad_formulada, cantidad_dispensada FROM dispensacion_hs_control WHERE id = ?`,
        [idControl]
      );
      const yaDispensado = Number(currentRows[0].cantidad_dispensada);
      const formulado    = Number(currentRows[0].cantidad_formulada);

      let nuevoTotal;
      if (tieneOverride) {
        nuevoTotal = Number(payload.cantidad_dispensada_total_override);
        if (nuevoTotal > formulado) {
          throw new HttpError(400,
            `No se puede fijar un acumulado (${nuevoTotal}) mayor a lo formulado (${formulado}).`
          );
        }
      } else {
        // A propósito NO se limita a "restante": algunos MX vienen en
        // unidades de entrega fijas (ej. un pen con varias dosis) y hay que
        // poder entregar la unidad completa aunque supere lo formulado. El
        // límite real de "cuánto sale del inventario" ya lo validó arriba
        // la suma de lotes contra el stock disponible.
        nuevoTotal = yaDispensado + cantidadDispensada;
      }
      nuevoEstado = 'parcial';
      if (nuevoTotal >= formulado) nuevoEstado = 'dispensado';
      if (nuevoTotal === 0)        nuevoEstado = 'pendiente';

      await connection.execute(
        `UPDATE dispensacion_hs_control
            SET cantidad_dispensada = ?,
                estado = ?,
                fecha_dispensacion = NOW(),
                id_usuario = ?,
                observaciones = CONCAT(COALESCE(observaciones,''), IF(? != '', CONCAT(IF(observaciones IS NOT NULL AND observaciones != '', ' | ', ''), ?), '')),
                contrato = ?,
                regimen = ?
          WHERE id = ?`,
        [nuevoTotal, nuevoEstado, userId ?? null,
         payload.observaciones ?? '', payload.observaciones ?? '',
         payload.contrato ?? null, payload.regimen ?? null, idControl]
      );
    } else {
      // Igual que en la rama de continuación: no se limita a lo formulado
      // (unidades de entrega fijas del MX) — el stock ya se validó arriba
      // contra los lotes elegidos.
      nuevoEstado = estado;
      const [insertResult] = await connection.execute(
        `INSERT INTO dispensacion_hs_control (
           id_formulacion_hs, id_med_formulacion_hs, id_paciente_hs,
           nombre_paciente, documento_paciente, nombre_medicamento, presentacion,
           cantidad_formulada, cantidad_dispensada, estado,
           fecha_formulacion, fecha_dispensacion, id_usuario, observaciones,
           contrato, regimen
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`,
        [
          id_formulacion_hs,
          id_med_formulacion_hs,
          formulacion.idPaciente,
          nombrePaciente,
          formulacion.documento_paciente ?? '',
          med.nombre_medicamento ?? '',
          med.presentacion ?? null,
          cantidadFormulada,
          cantidadInicial,
          estado,
          fechaFormulacion,
          userId ?? null,
          payload.observaciones ?? null,
          payload.contrato ?? null,
          payload.regimen ?? null
        ]
      );
      idControl = insertResult.insertId;
    }

    // Descuento real de inventario, lote por lote — solo si se está
    // entregando algo en esta acción (una corrección pura de acumulado no
    // toca el inventario).
    let idProductoResuelto = null;
    if (cantidadDispensada > 0) {
      for (const linea of lotes) {
        const [stockRows] = await connection.execute(
          `SELECT e.id_existencia, e.cantidad_disponible, e.id_almacen,
                  l.id_producto, l.costo_unitario, p.es_controlado, a.id_sede
             FROM existencias e
             INNER JOIN lotes l ON l.id_lote = e.id_lote
             INNER JOIN productos p ON p.id_producto = l.id_producto
             INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
            WHERE e.id_lote = ? AND e.id_ubicacion = ?
            FOR UPDATE`,
          [linea.id_lote, linea.id_ubicacion]
        );
        const stock = stockRows[0];
        if (!stock) {
          throw new HttpError(404, `No hay existencias para el lote ${linea.id_lote} en la ubicación indicada.`);
        }
        if (idSede != null && Number(stock.id_sede) !== Number(idSede)) {
          throw new HttpError(403, `El lote ${linea.id_lote} pertenece a otra sede — no se puede dispensar desde aquí.`);
        }
        if (Number(stock.cantidad_disponible) < Number(linea.cantidad)) {
          throw new HttpError(400,
            `Stock insuficiente en el lote ${linea.id_lote} (disponible: ${stock.cantidad_disponible}).`
          );
        }

        idProductoResuelto = stock.id_producto;

        await connection.execute(
          `UPDATE existencias SET cantidad_disponible = cantidad_disponible - ? WHERE id_existencia = ?`,
          [linea.cantidad, stock.id_existencia]
        );

        await connection.execute(
          `INSERT INTO movimientos_inventario (
             tipo, id_producto, id_lote, id_almacen_origen, id_ubicacion_origen,
             cantidad, costo_unitario, motivo, referencia_tipo, referencia_id, id_usuario
           ) VALUES ('salida_venta', ?, ?, ?, ?, ?, ?, ?, 'DISPENSACION_HS_CONTROL', ?, ?)`,
          [
            stock.id_producto, linea.id_lote, stock.id_almacen, linea.id_ubicacion,
            linea.cantidad, stock.costo_unitario, 'Salida por dispensación HS',
            idControl, userId ?? null
          ]
        );

        if (stock.es_controlado) {
          const saldoAnterior = Number(stock.cantidad_disponible);
          const saldoNuevo = saldoAnterior - Number(linea.cantidad);
          await connection.execute(
            `INSERT INTO controlados_libro (
               tipo_movimiento, id_producto, id_lote, cantidad, saldo_anterior, saldo_nuevo,
               referencia_tipo, referencia_id, usuario_responsable
             ) VALUES ('salida', ?, ?, ?, ?, ?, 'DISPENSACION_HS_CONTROL', ?, ?)`,
            [stock.id_producto, linea.id_lote, linea.cantidad, saldoAnterior, saldoNuevo, idControl, userId ?? null]
          );
        }
      }

      if (idProductoResuelto) {
        await connection.execute(
          `UPDATE dispensacion_hs_control SET id_producto = ? WHERE id = ?`,
          [idProductoResuelto, idControl]
        );
      }
    }

    const [finalRows] = await connection.execute(`SELECT * FROM dispensacion_hs_control WHERE id = ?`, [idControl]);

    await recordProcessTrace(connection, {
      proceso: 'DISPENSACION',
      subproceso: 'DISPENSAR_MEDICAMENTO_HS',
      id_sede: idSede,
      id_usuario: userId ?? null,
      referencia_tipo: 'DISPENSACION_HS_CONTROL',
      referencia_id: idControl,
      descripcion: tieneOverride
        ? `Dispensación ${esNuevo ? 'registrada' : 'actualizada'} con acumulado manual: ${med.nombre_medicamento ?? ''} (${nuevoEstado})`
        : `Dispensación ${esNuevo ? 'registrada' : 'actualizada'}: ${med.nombre_medicamento ?? ''} (${nuevoEstado})`,
      payload_json: {
        id_formulacion_hs,
        id_med_formulacion_hs,
        cantidad_dispensada: cantidadDispensada,
        lotes,
        cantidad_dispensada_total_override: tieneOverride ? Number(payload.cantidad_dispensada_total_override) : null,
        cantidad_pendiente_antes: payload.cantidad_pendiente_antes ?? null,
        cantidad_faltante: payload.cantidad_faltante ?? null,
        contrato: payload.contrato ?? null,
        regimen: payload.regimen ?? null
      }
    });

    return finalRows[0];
  });
}

export async function cancelarDispensacion(id, userId, idSede = null) {
  const [row] = await query(`SELECT id, nombre_medicamento FROM dispensacion_hs_control WHERE id = ?`, [id]);
  if (!row) throw new HttpError(404, 'Registro no encontrado');

  await query(
    `UPDATE dispensacion_hs_control SET estado = 'cancelado', id_usuario = ? WHERE id = ?`,
    [userId ?? null, id]
  );

  await recordProcessTrace(null, {
    proceso: 'DISPENSACION',
    subproceso: 'CANCELAR_DISPENSACION_HS',
    id_sede: idSede,
    id_usuario: userId ?? null,
    referencia_tipo: 'DISPENSACION_HS_CONTROL',
    referencia_id: id,
    descripcion: `Dispensación cancelada: ${row.nombre_medicamento ?? ''}`.trim()
  });

  return { id, estado: 'cancelado' };
}

function construirPosPaciente(formulacion, tipoDocumento) {
  const nombre = (formulacion.nombre_paciente ?? '').trim();
  const fechaNac = formulacion.fecha_nacimiento_paciente instanceof Date
    ? formulacion.fecha_nacimiento_paciente.toISOString().slice(0, 10)
    : (formulacion.fecha_nacimiento_paciente ? String(formulacion.fecha_nacimiento_paciente).slice(0, 10) : null);
  const sexoRaw = String(formulacion.sexo_paciente ?? '').trim().toUpperCase();
  return {
    tipoDocumentoIdentificacion: tipoDocumento || 'CC',
    numDocumentoIdentificacion: formulacion.documento_paciente,
    nombre: nombre || undefined,
    fechaNacimiento: fechaNac,
    codSexo: sexoRaw === 'M' || sexoRaw === 'F' ? sexoRaw : 'F',
    telefono: formulacion.telefono_paciente || formulacion.celular_paciente || undefined,
    direccion: formulacion.direccion_paciente || undefined
  };
}

/** Arma los items de PosMedicamento a partir de lo YA dispensado
 *  (dispensacion_hs_control, cantidad_dispensada > 0) para esta formulación,
 *  cruzando CUM/PBS locales (productos) y diagnóstico/prescriptor de HS. */
async function construirPosMedicamentos(idFormulacionHs, controlRows, prescriptor) {
  const idsProducto = [...new Set(controlRows.map(r => r.id_producto).filter(Boolean))];
  const productosMap = new Map();
  if (idsProducto.length) {
    const placeholders = idsProducto.map(() => '?').join(',');
    const rows = await query(
      `SELECT id_producto, cum, consecutivo_cum, unidad_medida, es_pbs FROM productos WHERE id_producto IN (${placeholders})`,
      idsProducto
    );
    for (const r of rows) productosMap.set(r.id_producto, r);
  }

  const idsMedFormulacion = controlRows.map(r => r.id_med_formulacion_hs).filter(id => id != null && id > 0);
  const dxMap = idsMedFormulacion.length ? await getDxPorIdMedFormulacion(idsMedFormulacion) : {};

  const fecha = new Date().toISOString().slice(0, 10);
  const items = [];
  const sinCum = [];

  for (const row of controlRows) {
    const producto = row.id_producto ? productosMap.get(row.id_producto) : null;
    if (!producto?.cum) {
      sinCum.push(row.nombre_medicamento);
      continue;
    }
    const dx = dxMap[row.id_med_formulacion_hs];
    items.push({
      codTecnologiaSalud: producto.consecutivo_cum ? `${producto.cum}-${producto.consecutivo_cum}` : String(producto.cum),
      nomTecnologiaSalud: row.nombre_medicamento,
      cantidadMedicamento: Number(row.cantidad_dispensada),
      unidadMinDispensa: producto.unidad_medida || 'UND',
      tipoMedicamento: producto.es_pbs ? TIPO_MEDICAMENTO_PBS : TIPO_MEDICAMENTO_NO_PBS,
      fechaDispensAdmon: fecha,
      codDiagnosticoPrincipal: dx?.cie10 || undefined,
      // Si hay número de documento pero no quedó el tipo (p.ej. el médico no
      // tiene tipo_documento diligenciado en HS), se asume CC — es el tipo
      // casi universal para profesionales de salud en Colombia, y evita que
      // falte este campo obligatorio del RIPS sin necesidad real.
      profesionalTipoDocumento: prescriptor?.tipo_documento_medico || (prescriptor?.numero_documento_medico ? 'CC' : undefined),
      profesionalNumDocumento: prescriptor?.numero_documento_medico || undefined
    });
  }

  return { items, sinCum };
}

async function registrarResultadoDianHS(idFormulacionHs, { modo, exito, resultado, error, requestPayload }) {
  await query(
    `INSERT INTO dispensacion_hs_dian (
      id_formulacion_hs, modo, factura_id, invoice_number, cufe, estado_dian, pdf_base64,
      paciente_invoice_number, paciente_cufe, paciente_estado_dian, paciente_pdf_base64,
      tirilla_pdf_base64, exito, error_mensaje, request_json, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      idFormulacionHs,
      modo ?? resultado?.modo ?? null,
      resultado?.factura_id ?? null,
      resultado?.eps?.invoice_number ?? null,
      resultado?.eps?.cufe ?? null,
      resultado?.eps?.estado_dian ?? null,
      resultado?.eps?.pdf_base64 ?? null,
      resultado?.paciente?.invoice_number ?? null,
      resultado?.paciente?.cufe ?? null,
      resultado?.paciente?.estado_dian ?? null,
      resultado?.paciente?.pdf_base64 ?? null,
      resultado?.tirilla_pdf_base64 ?? null,
      exito,
      error ?? null,
      JSON.stringify(requestPayload ?? {}),
      resultado ? JSON.stringify(resultado) : null
    ]
  );
}

/** Factura a la DIAN (copago/cuota moderadora) lo que YA se dispensó de una
 *  formulación — se llama UNA sola vez, después de que el frontend termina de
 *  dispensar cada medicamento (ese es el único punto donde "toda la visita" ya
 *  quedó confirmada; cada dispensarMedicamento() es su propia transacción).
 *  Si AkribeIA falla, la dispensación YA quedó registrada (el medicamento ya
 *  se entregó); el error queda guardado en dispensacion_hs_dian, nunca
 *  revierte nada de lo ya dispensado. */
export async function facturarSaludFormulacion(idFormulacionHs, payload, userId, userName) {
  if (!payload.tipo_cobro_usuario) {
    return { dian: null };
  }

  const [formulacion, controlRows] = await Promise.all([
    getFormulacionHSById(idFormulacionHs),
    getControlByFormulacion(idFormulacionHs)
  ]);
  if (!formulacion) {
    throw new HttpError(404, 'Formulación no encontrada en HealthSphere');
  }

  const dispensados = controlRows.filter(r => Number(r.cantidad_dispensada) > 0);
  if (!dispensados.length) {
    throw new HttpError(400, 'No hay medicamentos dispensados en esta formulación para facturar.');
  }

  const [tipoDocMap, prescriptorMap] = await Promise.all([
    getTipoDocumentoPacientePorId([formulacion.idPaciente]),
    getPrescriptorPorIdFormulacion([idFormulacionHs])
  ]);
  const prescriptor = prescriptorMap[idFormulacionHs] ?? null;

  const { items: medicamentos, sinCum } = await construirPosMedicamentos(idFormulacionHs, dispensados, prescriptor);
  if (!medicamentos.length) {
    throw new HttpError(400, `Ninguno de los medicamentos dispensados tiene CUM registrado en el maestro de productos (${sinCum.join(', ')}). No se puede facturar.`);
  }

  const requestPayload = {
    external_ref: `HS-${idFormulacionHs}`,
    pos_usuario_nombre: userName || undefined,
    contrato_numero: payload.contrato_numero,
    centro_costo_id: payload.centro_costo_id,
    punto_pago_sede_id: payload.punto_pago_sede_id,
    tipo_cobro_usuario: payload.tipo_cobro_usuario,
    pago_usuario_porcentaje: payload.pago_usuario_porcentaje ?? undefined,
    pago_usuario_monto: payload.pago_usuario_monto ?? undefined,
    paciente: construirPosPaciente(formulacion, tipoDocMap[formulacion.idPaciente]),
    medicamentos
  };

  try {
    const respuesta = await crearFacturaSalud(requestPayload);
    // Igual que en el flujo anterior: AkribeIA solo manda `ok` cuando falla;
    // si llegamos hasta acá sin excepción, fue éxito.
    const dian = { ok: true, ...respuesta };
    await registrarResultadoDianHS(idFormulacionHs, { exito: true, resultado: dian, requestPayload });
    return { dian };
  } catch (error) {
    await registrarResultadoDianHS(idFormulacionHs, { exito: false, error: error.message, requestPayload });
    return { dian: { ok: false, error: error.message } };
  }
}

export async function listDianInvoicesHS(search = '') {
  const filter = String(search ?? '').trim();
  const wildcard = `%${filter}%`;
  return query(
    `SELECT dhd.*,
            MIN(dc.nombre_medicamento) AS ejemplo_medicamento,
            MIN(dc.nombre_paciente) AS paciente_nombre,
            MIN(dc.documento_paciente) AS paciente_documento
     FROM dispensacion_hs_dian dhd
     LEFT JOIN dispensacion_hs_control dc ON dc.id_formulacion_hs = dhd.id_formulacion_hs
     WHERE (? = '' OR dhd.paciente_invoice_number LIKE ? OR dhd.invoice_number LIKE ? OR dc.nombre_paciente LIKE ? OR dc.documento_paciente LIKE ?)
     GROUP BY dhd.id
     ORDER BY dhd.fecha_creacion DESC
     LIMIT 200`,
    [filter, wildcard, wildcard, wildcard, wildcard]
  );
}

async function obtenerFacturaDianHSOriginal(id) {
  const [row] = await query(
    `SELECT * FROM dispensacion_hs_dian WHERE id = ? AND modo NOT IN ('nota_credito', 'nota_debito')`,
    [id]
  );
  if (!row) throw new HttpError(404, 'Factura de salud no encontrada');
  if (!row.paciente_invoice_number) {
    throw new HttpError(400, 'Esta dispensación no generó factura al paciente (sin copago/cuota moderadora) — no hay nada que ver/anular por esta vía.');
  }
  return row;
}

export async function obtenerDocumentosDianHS(id) {
  const row = await obtenerFacturaDianHSOriginal(id);
  return obtenerDocumentosSalud({ factura_id: row.factura_id });
}

async function registrarNotaAjusteHS(row, tipo, resultado) {
  await query(
    `INSERT INTO dispensacion_hs_dian (
      id_formulacion_hs, modo, factura_id, paciente_invoice_number, paciente_cufe,
      paciente_estado_dian, paciente_pdf_base64, exito, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id_formulacion_hs, tipo, row.factura_id,
      resultado.numero_nota ?? null, resultado.cude ?? null, resultado.estado_dian ?? null,
      resultado.pdf_base64 ?? null, true, JSON.stringify(resultado)
    ]
  );
  if (tipo === 'nota_credito') {
    await query(`UPDATE dispensacion_hs_dian SET anulada = TRUE WHERE id = ?`, [row.id]);
  }
}

export async function emitirNotaCreditoDianHS(id, motivo) {
  const row = await obtenerFacturaDianHSOriginal(id);
  if (row.anulada) throw new HttpError(400, 'Esta factura ya fue anulada anteriormente.');
  const resultado = await crearNotaCreditoSalud({ factura_id: row.factura_id, motivo: motivo || undefined });
  await registrarNotaAjusteHS(row, 'nota_credito', resultado);
  return resultado;
}

export async function emitirNotaDebitoDianHS(id, motivo) {
  const row = await obtenerFacturaDianHSOriginal(id);
  const resultado = await crearNotaDebitoSalud({ factura_id: row.factura_id, motivo: motivo || undefined });
  await registrarNotaAjusteHS(row, 'nota_debito', resultado);
  return resultado;
}
