-- Vincula proveedores con su laboratorio en la tabla de maestras
-- Ejecutar una vez; columna nullable para no romper registros existentes.

ALTER TABLE proveedores
  ADD COLUMN id_laboratorio INT NULL,
  ADD CONSTRAINT fk_proveedores_laboratorio
    FOREIGN KEY (id_laboratorio) REFERENCES laboratorios(id_laboratorio)
    ON UPDATE CASCADE ON DELETE SET NULL;
