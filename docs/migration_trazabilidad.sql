-- ============================================================
-- Migración: Trazabilidad completa por usuario
-- Ejecutar una sola vez sobre la base de datos de producción
-- ============================================================

-- 1. Agregar creado_por a la tabla ingresos
-- (Las demás tablas clave ya tienen este campo:
--  ordenes_compra.creado_por, dispensaciones.id_usuario,
--  ventas.creado_por, movimientos_inventario.id_usuario)
ALTER TABLE ingresos
  ADD COLUMN creado_por INT NULL COMMENT 'id_usuario que creó el registro',
  ADD CONSTRAINT fk_ingresos_creado_por
    FOREIGN KEY (creado_por) REFERENCES usuarios(id_usuario)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Índice para consultas de trazabilidad por usuario
CREATE INDEX idx_ingresos_creado_por ON ingresos(creado_por);

-- 2. Verificar que log_auditoria existe con todas las columnas
--    (Si la tabla ya existe, estas sentencias no hacen nada gracias al IF NOT EXISTS)
CREATE TABLE IF NOT EXISTS log_auditoria (
  id_auditoria     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  fecha_hora       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  id_usuario       INT NULL,
  perfil_nombre    VARCHAR(100) NULL,
  id_sede          INT NULL,
  modulo           VARCHAR(80) NOT NULL DEFAULT 'GENERAL',
  submodulo        VARCHAR(80) NULL,
  tabla_afectada   VARCHAR(100) NULL,
  id_registro      BIGINT NULL,
  accion           ENUM('INSERT','UPDATE','DELETE','SELECT','LOGIN','OTRO') NOT NULL DEFAULT 'OTRO',
  descripcion      TEXT NULL,
  resultado        ENUM('exitoso','parcial','fallido') NOT NULL DEFAULT 'exitoso',
  datos_anteriores JSON NULL,
  datos_nuevos     JSON NULL,
  campos_modificados JSON NULL,
  metadata         JSON NULL,
  mensaje_error    TEXT NULL,
  request_id       VARCHAR(36) NULL,
  endpoint         VARCHAR(500) NULL,
  http_method      VARCHAR(10) NULL,
  http_status      SMALLINT NULL,
  severidad        ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  session_hash     VARCHAR(64) NULL,
  duracion_ms      INT NULL,
  INDEX idx_la_fecha_hora   (fecha_hora),
  INDEX idx_la_id_usuario   (id_usuario),
  INDEX idx_la_id_sede      (id_sede),
  INDEX idx_la_modulo       (modulo),
  INDEX idx_la_accion       (accion),
  INDEX idx_la_resultado    (resultado),
  INDEX idx_la_request_id   (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Verificar que procesos_terminados_trazabilidad existe
CREATE TABLE IF NOT EXISTS procesos_terminados_trazabilidad (
  id_traza         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id       VARCHAR(36) NULL,
  fecha_hora       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  proceso          VARCHAR(80) NOT NULL DEFAULT 'GENERAL',
  subproceso       VARCHAR(80) NULL,
  estado           ENUM('terminado','parcial','cancelado','error') NOT NULL DEFAULT 'terminado',
  id_sede          INT NULL,
  id_usuario       INT NULL,
  perfil_nombre    VARCHAR(100) NULL,
  referencia_tipo  VARCHAR(80) NULL,
  referencia_id    BIGINT NULL,
  descripcion      TEXT NULL,
  endpoint         VARCHAR(500) NULL,
  http_method      VARCHAR(10) NULL,
  http_status      SMALLINT NULL,
  duracion_ms      INT NULL,
  session_hash     VARCHAR(64) NULL,
  payload_json     JSON NULL,
  INDEX idx_ptt_fecha_hora  (fecha_hora),
  INDEX idx_ptt_id_usuario  (id_usuario),
  INDEX idx_ptt_id_sede     (id_sede),
  INDEX idx_ptt_proceso     (proceso),
  INDEX idx_ptt_estado      (estado),
  INDEX idx_ptt_request_id  (request_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. (Opcional) Índice en movimientos_inventario.id_usuario si no existe
--    para acelerar consultas de trazabilidad por usuario
CREATE INDEX IF NOT EXISTS idx_mi_id_usuario ON movimientos_inventario(id_usuario);

-- 5. (Opcional) Índice en ordenes_compra.creado_por si no existe
CREATE INDEX IF NOT EXISTS idx_oc_creado_por ON ordenes_compra(creado_por);

-- ============================================================
-- RESUMEN FINAL de campos de auditoría por tabla:
--
--   ingresos              → creado_por (INT, FK usuarios)       ← NUEVO
--   ordenes_compra        → creado_por (INT, FK usuarios)       ← ya existía
--   dispensaciones        → id_usuario (INT)                    ← ya existía
--   ventas                → creado_por (INT)                    ← ya existía
--   movimientos_inventario→ id_usuario (INT)                    ← ya existía
--   log_auditoria         → tabla completa de auditoría HTTP    ← ya existía
--   procesos_terminados_trazabilidad → tabla de trazabilidad    ← ya existía
-- ============================================================
