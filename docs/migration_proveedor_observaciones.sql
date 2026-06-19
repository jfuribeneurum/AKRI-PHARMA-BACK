-- Agrega el campo de observaciones/notas del proveedor.
-- Ya ejecutada en producción.

ALTER TABLE proveedores
  ADD COLUMN observaciones TEXT NULL;
