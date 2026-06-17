-- Ejecutar una vez. Agrega columnas estructuradas a ingresos y crea ingresos_items.

ALTER TABLE ingresos
  ADD COLUMN prefijo_factura      VARCHAR(20)    NULL,
  ADD COLUMN numero_factura       VARCHAR(50)    NULL,
  ADD COLUMN cufe                 VARCHAR(255)   NULL,
  ADD COLUMN fecha_recepcion      DATE           NULL,
  ADD COLUMN observaciones        TEXT           NULL,
  ADD COLUMN numero_orden_compra  VARCHAR(100)   NULL,
  ADD COLUMN sede                 VARCHAR(200)   NULL,
  ADD COLUMN bodega               VARCHAR(200)   NULL,
  ADD COLUMN proveedor_nombre     VARCHAR(200)   NULL,
  ADD COLUMN proveedor_nit        VARCHAR(50)    NULL,
  ADD COLUMN proveedor_contacto   VARCHAR(200)   NULL,
  ADD COLUMN proveedor_telefono   VARCHAR(50)    NULL,
  ADD COLUMN proveedor_direccion  VARCHAR(300)   NULL,
  ADD COLUMN total_bruto          DECIMAL(15,2)  NULL,
  ADD COLUMN total_descuento      DECIMAL(15,2)  NULL,
  ADD COLUMN subtotal_neto        DECIMAL(15,2)  NULL,
  ADD COLUMN total_iva            DECIMAL(15,2)  NULL,
  ADD COLUMN total_ingreso        DECIMAL(15,2)  NULL;

CREATE TABLE IF NOT EXISTS ingresos_items (
  id_item            INT            NOT NULL AUTO_INCREMENT,
  id_ingreso         INT            NOT NULL,
  codigo             VARCHAR(100)   NULL,
  nombre             VARCHAR(300)   NULL,
  laboratorio        VARCHAR(200)   NULL,
  cantidad           DECIMAL(15,4)  NOT NULL DEFAULT 0,
  valor_unitario     DECIMAL(15,4)  NOT NULL DEFAULT 0,
  descuento_pct      DECIMAL(8,4)   NOT NULL DEFAULT 0,
  descuento_valor    DECIMAL(15,2)  NOT NULL DEFAULT 0,
  iva                DECIMAL(8,4)   NOT NULL DEFAULT 0,
  lote               VARCHAR(100)   NULL,
  fecha_vencimiento  DATE           NULL,
  registro_invima    VARCHAR(100)   NULL,
  cum                VARCHAR(100)   NULL,
  consecutivo_cum    VARCHAR(100)   NULL,
  presentacion       VARCHAR(200)   NULL,
  temperatura        VARCHAR(100)   NULL,
  cumple             TINYINT(1)     NULL,
  PRIMARY KEY (id_item),
  CONSTRAINT fk_ingresos_items_ingreso
    FOREIGN KEY (id_ingreso) REFERENCES ingresos(id_ingreso)
    ON DELETE CASCADE
);
