import { query } from '../config/db.js';
import { HttpError } from '../utils/http-error.js';

const SEED = [
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'medicamento',          etiqueta: 'Medicamento',                  orden: 1 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'insumo',               etiqueta: 'Insumo',                       orden: 2 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'controlado',           etiqueta: 'Controlado',                   orden: 3 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'vacuna',               etiqueta: 'Vacuna',                       orden: 4 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'dispositivo',          etiqueta: 'Dispositivo médico',           orden: 5 },
  { grupo: 'tipo_producto',            grupo_label: 'Tipo de Producto',           valor: 'otro',                 etiqueta: 'Otro',                         orden: 6 },

  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'NIT',                  etiqueta: 'NIT',                          orden: 1 },
  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'CC',                   etiqueta: 'Cédula de ciudadanía',         orden: 2 },
  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'CE',                   etiqueta: 'Cédula de extranjería',        orden: 3 },
  { grupo: 'tipo_identificacion',      grupo_label: 'Tipo de Identificación',     valor: 'Pasaporte',            etiqueta: 'Pasaporte',                    orden: 4 },

  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Producto vencido',                    etiqueta: 'Producto vencido',                    orden: 1 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Producto dañado / deteriorado',        etiqueta: 'Producto dañado / deteriorado',        orden: 2 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Error en pedido',                      etiqueta: 'Error en pedido',                      orden: 3 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Exceso de inventario',                 etiqueta: 'Exceso de inventario',                 orden: 4 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Producto no requerido',                etiqueta: 'Producto no requerido',                orden: 5 },
  { grupo: 'motivo_devolucion',        grupo_label: 'Motivo de Devolución',       valor: 'Otro',                                 etiqueta: 'Otro',                                 orden: 6 },

  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Sin stock',                            etiqueta: 'Sin stock',                            orden: 1 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Lote no disponible',                   etiqueta: 'Lote no disponible',                   orden: 2 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Pendiente autorización',               etiqueta: 'Pendiente autorización',               orden: 3 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'No entregado por novedad',             etiqueta: 'No entregado por novedad',             orden: 4 },
  { grupo: 'motivo_faltante',          grupo_label: 'Motivo de Faltante',         valor: 'Otro',                                 etiqueta: 'Otro',                                 orden: 5 },

  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Ajuste por conteo físico',             etiqueta: 'Ajuste por conteo físico',             orden: 1 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Avería o pérdida',                     etiqueta: 'Avería o pérdida',                     orden: 2 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Vencimiento',                          etiqueta: 'Vencimiento',                          orden: 3 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Diferencia de inventario',             etiqueta: 'Diferencia de inventario',             orden: 4 },
  { grupo: 'motivo_ajuste',            grupo_label: 'Motivo de Ajuste',           valor: 'Otro ajuste',                          etiqueta: 'Otro ajuste',                          orden: 5 },

  { grupo: 'estado_ingreso',           grupo_label: 'Estado de Ingreso',          valor: 'pendiente',    etiqueta: 'Pendiente',    orden: 1 },
  { grupo: 'estado_ingreso',           grupo_label: 'Estado de Ingreso',          valor: 'recibido',     etiqueta: 'Recibido',     orden: 2 },
  { grupo: 'estado_ingreso',           grupo_label: 'Estado de Ingreso',          valor: 'almacenado',   etiqueta: 'Almacenado',   orden: 3 },
  { grupo: 'estado_ingreso',           grupo_label: 'Estado de Ingreso',          valor: 'cancelado',    etiqueta: 'Cancelado',    orden: 4 },

  { grupo: 'tipo_movimiento_entrada',  grupo_label: 'Tipo Movimiento Entrada',    valor: 'entrada_compra',       etiqueta: 'Entrada compra',               orden: 1 },
  { grupo: 'tipo_movimiento_entrada',  grupo_label: 'Tipo Movimiento Entrada',    valor: 'devolucion_venta',     etiqueta: 'Devolución de venta',          orden: 2 },
  { grupo: 'tipo_movimiento_entrada',  grupo_label: 'Tipo Movimiento Entrada',    valor: 'liberacion',           etiqueta: 'Liberación de cuarentena',     orden: 3 },

  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'salida_venta',         etiqueta: 'Salida por venta',             orden: 1 },
  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'merma',                etiqueta: 'Merma',                        orden: 2 },
  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'destruccion',          etiqueta: 'Destrucción',                  orden: 3 },
  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'cuarentena',           etiqueta: 'Pasar a cuarentena',           orden: 4 },
  { grupo: 'tipo_movimiento_salida',   grupo_label: 'Tipo Movimiento Salida',     valor: 'devolucion_compra',    etiqueta: 'Devolución a proveedor',       orden: 5 },

  { grupo: 'tipo_receptor',            grupo_label: 'Tipo de Receptor',           valor: 'paciente',        etiqueta: 'Paciente',        orden: 1 },
  { grupo: 'tipo_receptor',            grupo_label: 'Tipo de Receptor',           valor: 'representante',   etiqueta: 'Representante',   orden: 2 },
  { grupo: 'tipo_receptor',            grupo_label: 'Tipo de Receptor',           valor: 'domiciliario',    etiqueta: 'Domiciliario',    orden: 3 },

  { grupo: 'genero',                   grupo_label: 'Género',                     valor: 'F',   etiqueta: 'Femenino',    orden: 1 },
  { grupo: 'genero',                   grupo_label: 'Género',                     valor: 'M',   etiqueta: 'Masculino',   orden: 2 },
  { grupo: 'genero',                   grupo_label: 'Género',                     valor: 'O',   etiqueta: 'Otro',        orden: 3 },
];

export async function initParametrosTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS parametros_sistema (
      id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      grupo       VARCHAR(80)  NOT NULL,
      grupo_label VARCHAR(120) NOT NULL,
      valor       VARCHAR(200) NOT NULL,
      etiqueta    VARCHAR(200) NOT NULL,
      orden       SMALLINT     NOT NULL DEFAULT 0,
      activo      TINYINT(1)   NOT NULL DEFAULT 1,
      UNIQUE KEY uq_grupo_valor (grupo, valor)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [{ cnt }] = await query(`SELECT COUNT(*) AS cnt FROM parametros_sistema`);
  if (Number(cnt) === 0) {
    for (const row of SEED) {
      await query(
        `INSERT IGNORE INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo) VALUES (?, ?, ?, ?, ?, 1)`,
        [row.grupo, row.grupo_label, row.valor, row.etiqueta, row.orden]
      );
    }
  }
}

export async function listGrupos() {
  return query(`
    SELECT grupo, grupo_label, COUNT(*) AS total, SUM(activo) AS activos
    FROM parametros_sistema
    GROUP BY grupo, grupo_label
    ORDER BY grupo_label ASC
  `);
}

export async function listByGrupo(grupo) {
  return query(
    `SELECT id, grupo, grupo_label, valor, etiqueta, orden, activo
     FROM parametros_sistema
     WHERE grupo = ?
     ORDER BY orden ASC, etiqueta ASC`,
    [grupo]
  );
}

export async function listActivosByGrupo(grupo) {
  return query(
    `SELECT valor, etiqueta FROM parametros_sistema
     WHERE grupo = ? AND activo = 1
     ORDER BY orden ASC, etiqueta ASC`,
    [grupo]
  );
}

export async function getParametroById(id) {
  const [row] = await query(`SELECT * FROM parametros_sistema WHERE id = ?`, [id]);
  return row ?? null;
}

export async function createParametro(data) {
  const grupo       = (data.grupo ?? '').trim();
  const grupo_label = (data.grupo_label ?? '').trim();
  const valor       = (data.valor ?? '').trim();
  const etiqueta    = (data.etiqueta ?? '').trim();
  const orden       = Number(data.orden ?? 0);

  if (!grupo)       throw new HttpError(400, 'El grupo es requerido');
  if (!valor)       throw new HttpError(400, 'El valor es requerido');
  if (!etiqueta)    throw new HttpError(400, 'La etiqueta es requerida');

  const [existing] = await query(
    `SELECT id FROM parametros_sistema WHERE grupo = ? AND valor = ?`,
    [grupo, valor]
  );
  if (existing) throw new HttpError(409, `Ya existe una opción con valor "${valor}" en este grupo`);

  const result = await query(
    `INSERT INTO parametros_sistema (grupo, grupo_label, valor, etiqueta, orden, activo) VALUES (?, ?, ?, ?, ?, 1)`,
    [grupo, grupo_label || grupo, valor, etiqueta, orden]
  );
  return { id: result.insertId };
}

export async function updateParametro(id, data) {
  const row = await getParametroById(id);
  if (!row) throw new HttpError(404, 'Parámetro no encontrado');

  const etiqueta = (data.etiqueta ?? row.etiqueta).trim();
  const orden    = data.orden !== undefined ? Number(data.orden) : row.orden;

  if (!etiqueta) throw new HttpError(400, 'La etiqueta es requerida');

  await query(
    `UPDATE parametros_sistema SET etiqueta = ?, orden = ? WHERE id = ?`,
    [etiqueta, orden, id]
  );
}

export async function toggleParametro(id) {
  const row = await getParametroById(id);
  if (!row) throw new HttpError(404, 'Parámetro no encontrado');
  await query(`UPDATE parametros_sistema SET activo = ? WHERE id = ?`, [row.activo ? 0 : 1, id]);
  return { activo: !row.activo };
}

export async function deleteParametro(id) {
  const row = await getParametroById(id);
  if (!row) throw new HttpError(404, 'Parámetro no encontrado');
  await query(`DELETE FROM parametros_sistema WHERE id = ?`, [id]);
}
