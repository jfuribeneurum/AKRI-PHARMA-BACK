-- Elimina regimen_proveedor de productos; el campo se gestiona ahora en la tabla proveedores.
-- Ejecutar una vez en producción.

ALTER TABLE productos
  DROP COLUMN regimen_proveedor;
