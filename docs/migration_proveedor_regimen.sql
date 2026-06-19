-- Agrega el régimen tributario del proveedor (antes estaba en productos).
-- Ejecutar una vez; columna nullable para no romper registros existentes.

ALTER TABLE proveedores
  ADD COLUMN regimen VARCHAR(50) NULL;
