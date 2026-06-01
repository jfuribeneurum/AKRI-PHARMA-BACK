-- Migración: tabla traslados
-- Gestiona el flujo envío → recepción de mercancía entre bodegas.
-- El stock NO se mueve hasta que la bodega receptora confirma recepción.

CREATE TABLE IF NOT EXISTS traslados (
  id_traslado          INT AUTO_INCREMENT PRIMARY KEY,
  id_producto          INT          NOT NULL,
  id_lote              INT          NOT NULL,
  id_almacen_origen    INT          NOT NULL,
  id_ubicacion_origen  INT          NOT NULL,
  id_almacen_destino   INT          NOT NULL,
  id_ubicacion_destino INT          NOT NULL,
  cantidad             DECIMAL(12,3) NOT NULL,
  motivo               TEXT         NULL,
  estado               ENUM('pendiente','recibido','rechazado') NOT NULL DEFAULT 'pendiente',
  id_usuario_origen    INT          NULL,
  id_usuario_destino   INT          NULL,
  observaciones_recepcion TEXT      NULL,
  id_movimiento        INT          NULL,   -- movimiento en movimientos_inventario creado al recibir
  fecha_envio          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fecha_recepcion      DATETIME     NULL,

  KEY idx_estado           (estado),
  KEY idx_almacen_destino  (id_almacen_destino),
  KEY idx_almacen_origen   (id_almacen_origen),
  KEY idx_lote             (id_lote),

  CONSTRAINT fk_traslado_producto  FOREIGN KEY (id_producto)          REFERENCES productos(id_producto),
  CONSTRAINT fk_traslado_lote      FOREIGN KEY (id_lote)              REFERENCES lotes(id_lote),
  CONSTRAINT fk_traslado_alm_orig  FOREIGN KEY (id_almacen_origen)    REFERENCES almacenes(id_almacen),
  CONSTRAINT fk_traslado_alm_dest  FOREIGN KEY (id_almacen_destino)   REFERENCES almacenes(id_almacen)
);
