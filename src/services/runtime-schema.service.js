import { pool, query } from '../config/db.js';

let ensurePromise = null;

async function runStatement(sql, params = []) {
  const connection = await pool.getConnection();
  try {
    await connection.query(sql, params);
  } finally {
    connection.release();
  }
}

async function tableExists(tableName) {
  const rows = await query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

async function columnExists(tableName, columnName) {
  const rows = await query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

async function constraintExists(tableName, constraintName) {
  const rows = await query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = ?`,
    [tableName, constraintName]
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

async function indexExists(tableName, indexName) {
  const rows = await query(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [tableName, indexName]
  );
  return Number(rows[0]?.total ?? 0) > 0;
}

async function tryStep(name, work) {
  try {
    await work();
    return true;
  } catch (error) {
    console.warn(`[schema] ${name}: ${error.message}`);
    return false;
  }
}

async function ensureRoleUsabilities() {
  const hasRoles = await tableExists('roles');
  if (!hasRoles) {
    return;
  }

  if (!(await tableExists('role_usabilities'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS role_usabilities (
          id_role_usability INT AUTO_INCREMENT PRIMARY KEY,
          id_rol INT NOT NULL,
          clave VARCHAR(80) NOT NULL,
          nombre VARCHAR(120) NOT NULL,
          descripcion VARCHAR(255) DEFAULT NULL,
          categoria VARCHAR(60) NOT NULL DEFAULT 'general',
          habilitado BOOLEAN DEFAULT TRUE,
          metadata JSON DEFAULT NULL,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          fecha_modificacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_role_usability (id_rol, clave),
          CONSTRAINT fk_role_usability_rol FOREIGN KEY (id_rol) REFERENCES roles(id_rol) ON DELETE CASCADE,
          INDEX idx_role_usability_categoria (categoria, habilitado)
      ) ENGINE=InnoDB COMMENT='Usabilidades / capacidades habilitadas por perfil'
    `);
    console.log('[schema] Tabla role_usabilities creada en runtime');
  }

  await runStatement(`
    INSERT INTO role_usabilities (id_rol, clave, nombre, descripcion, categoria, habilitado, metadata)
    SELECT r.id_rol, u.clave, u.nombre, u.descripcion, u.categoria, u.habilitado, u.metadata
    FROM roles r
    CROSS JOIN (
      SELECT 'inventory.local_general' AS clave, 'Inventario local y general' AS nombre, 'Vista local por sede y consolidado general' AS descripcion, 'inventario' AS categoria, TRUE AS habilitado, JSON_OBJECT('default_scope','general') AS metadata
      UNION ALL SELECT 'dispensing.requests.manual', 'Solicitudes manuales', 'Crear solicitudes manuales item por item', 'dispensacion', TRUE, JSON_OBJECT()
      UNION ALL SELECT 'dispensing.requests.ehr', 'Importación HCE', 'Crear solicitudes desde payload clínico / API HCE', 'dispensacion', TRUE, JSON_OBJECT('format','json')
      UNION ALL SELECT 'dispensing.requests.prescription_scan', 'Fórmula escaneada', 'Crear solicitudes desde fórmula escaneada', 'dispensacion', TRUE, JSON_OBJECT('supports_pdf', TRUE)
      UNION ALL SELECT 'scanners.auto_detect', 'Auto detección de lectores', 'Detectar canal disponible y registrar perfil físico', 'lectores', TRUE, JSON_OBJECT('channels', JSON_ARRAY('keyboard_wedge','webhid','webserial','webusb','camera'))
      UNION ALL SELECT 'traceability.process_finished', 'Trazabilidad de procesos', 'Consultar quién terminó cada proceso', 'auditoria', TRUE, JSON_OBJECT()
    ) u
    WHERE NOT EXISTS (
      SELECT 1 FROM role_usabilities ru WHERE ru.id_rol = r.id_rol AND ru.clave = u.clave
    )
  `);
}

async function ensureBarcodeScannerSchema() {
  if (await tableExists('escaneos_codigo_barras')) {
    await runStatement(`
      ALTER TABLE escaneos_codigo_barras
        ADD COLUMN IF NOT EXISTS canal_lectura ENUM('keyboard_wedge','webhid','webserial','webusb','camera','image_upload','manual','unknown') DEFAULT 'unknown' AFTER fuente,
        ADD COLUMN IF NOT EXISTS tipo_scanner ENUM('lapiz_optico','ranura','ccd','imagen','laser_pistola','generic_wedge','desconocido') DEFAULT 'desconocido' AFTER canal_lectura,
        ADD COLUMN IF NOT EXISTS forma_uso ENUM('pistola','fijo','mesa','portatil','wearable','desconocida') DEFAULT 'desconocida' AFTER tipo_scanner,
        ADD COLUMN IF NOT EXISTS scanner_label VARCHAR(120) DEFAULT NULL AFTER forma_uso,
        ADD COLUMN IF NOT EXISTS scanner_vendor_id VARCHAR(20) DEFAULT NULL AFTER scanner_label,
        ADD COLUMN IF NOT EXISTS scanner_product_id VARCHAR(20) DEFAULT NULL AFTER scanner_vendor_id
    `);
  }

  const prerequisites = (await Promise.all([
    tableExists('sedes'),
    tableExists('usuarios')
  ])).every(Boolean);

  if (prerequisites && !(await tableExists('scanner_profiles'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS scanner_profiles (
          id_scanner_profile INT AUTO_INCREMENT PRIMARY KEY,
          id_sede INT NOT NULL,
          nombre VARCHAR(120) NOT NULL,
          canal_preferido ENUM('keyboard_wedge','webhid','webserial','webusb','camera','image_upload','manual') NOT NULL DEFAULT 'keyboard_wedge',
          tipo_scanner ENUM('lapiz_optico','ranura','ccd','imagen','laser_pistola','generic_wedge','desconocido') NOT NULL DEFAULT 'desconocido',
          forma_uso ENUM('pistola','fijo','mesa','portatil','wearable','desconocida') NOT NULL DEFAULT 'desconocida',
          vendor_id VARCHAR(20) DEFAULT NULL,
          product_id VARCHAR(20) DEFAULT NULL,
          serial_number VARCHAR(80) DEFAULT NULL,
          patron_entrada VARCHAR(120) DEFAULT NULL,
          teclado_sufijo VARCHAR(10) DEFAULT 'Enter',
          activo BOOLEAN DEFAULT TRUE,
          metadata JSON DEFAULT NULL,
          creado_por INT DEFAULT NULL,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          fecha_modificacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_scanner_profile_sede FOREIGN KEY (id_sede) REFERENCES sedes(id_sede),
          CONSTRAINT fk_scanner_profile_user FOREIGN KEY (creado_por) REFERENCES usuarios(id_usuario),
          INDEX idx_scanner_profile_sede (id_sede),
          INDEX idx_scanner_profile_tipo (tipo_scanner),
          INDEX idx_scanner_profile_vendor (vendor_id, product_id)
      ) ENGINE=InnoDB COMMENT='Perfiles de lectores de código de barras por sede'
    `);
  }
}

async function ensureDispensingRequestSchema() {
  const baseReqs = (await Promise.all([
    tableExists('sedes'),
    tableExists('almacenes'),
    tableExists('usuarios'),
    tableExists('pacientes'),
    tableExists('medicos'),
    tableExists('productos'),
    tableExists('dispensaciones')
  ])).every(Boolean);

  if (!baseReqs) {
    return;
  }

  if (!(await tableExists('solicitudes_dispensacion'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS solicitudes_dispensacion (
          id_solicitud_dispensacion BIGINT AUTO_INCREMENT PRIMARY KEY,
          consecutivo VARCHAR(30) NOT NULL UNIQUE,
          tipo_origen ENUM('manual','api_hce','formula_escaneada') NOT NULL DEFAULT 'manual',
          estado ENUM('borrador','pendiente','validada','dispensada','cancelada') NOT NULL DEFAULT 'pendiente',
          id_sede INT NOT NULL,
          id_almacen_sugerido INT DEFAULT NULL,
          id_usuario_solicita INT NOT NULL,
          id_usuario_valida INT DEFAULT NULL,
          id_paciente INT NOT NULL,
          id_medico INT DEFAULT NULL,
          referencia_externa VARCHAR(120) DEFAULT NULL,
          archivo_nombre VARCHAR(255) DEFAULT NULL,
          archivo_data_url LONGTEXT DEFAULT NULL,
          payload_origen JSON DEFAULT NULL,
          observaciones TEXT,
          fecha_solicitud DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          fecha_validacion DATETIME DEFAULT NULL,
          fecha_modificacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_sol_disp_sede FOREIGN KEY (id_sede) REFERENCES sedes(id_sede),
          CONSTRAINT fk_sol_disp_almacen FOREIGN KEY (id_almacen_sugerido) REFERENCES almacenes(id_almacen),
          CONSTRAINT fk_sol_disp_user_req FOREIGN KEY (id_usuario_solicita) REFERENCES usuarios(id_usuario),
          CONSTRAINT fk_sol_disp_user_val FOREIGN KEY (id_usuario_valida) REFERENCES usuarios(id_usuario),
          CONSTRAINT fk_sol_disp_paciente FOREIGN KEY (id_paciente) REFERENCES pacientes(id_paciente),
          CONSTRAINT fk_sol_disp_medico FOREIGN KEY (id_medico) REFERENCES medicos(id_medico),
          INDEX idx_sol_disp_fecha (fecha_solicitud),
          INDEX idx_sol_disp_estado (estado),
          INDEX idx_sol_disp_tipo (tipo_origen),
          INDEX idx_sol_disp_sede (id_sede)
      ) ENGINE=InnoDB COMMENT='Solicitudes de dispensación generadas manualmente, por API clínica o por fórmula escaneada'
    `);
  }

  if (!(await tableExists('solicitudes_dispensacion_detalle'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS solicitudes_dispensacion_detalle (
          id_solicitud_detalle BIGINT AUTO_INCREMENT PRIMARY KEY,
          id_solicitud_dispensacion BIGINT NOT NULL,
          id_producto INT DEFAULT NULL,
          descripcion_libre VARCHAR(255) NOT NULL,
          dosis VARCHAR(80) DEFAULT NULL,
          via_administracion VARCHAR(80) DEFAULT NULL,
          frecuencia VARCHAR(80) DEFAULT NULL,
          duracion VARCHAR(80) DEFAULT NULL,
          cantidad_solicitada DECIMAL(14,3) NOT NULL,
          observaciones VARCHAR(255) DEFAULT NULL,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_sol_disp_det_header FOREIGN KEY (id_solicitud_dispensacion) REFERENCES solicitudes_dispensacion(id_solicitud_dispensacion) ON DELETE CASCADE,
          CONSTRAINT fk_sol_disp_det_producto FOREIGN KEY (id_producto) REFERENCES productos(id_producto),
          INDEX idx_sol_disp_det_prod (id_producto)
      ) ENGINE=InnoDB COMMENT='Detalle item a item de solicitudes de dispensación'
    `);
  }

  if (!(await columnExists('dispensaciones', 'id_solicitud_dispensacion'))) {
    await runStatement(`ALTER TABLE dispensaciones ADD COLUMN id_solicitud_dispensacion BIGINT DEFAULT NULL AFTER id_paciente`);
  }

  if (!(await constraintExists('dispensaciones', 'fk_disp_solicitud'))) {
    await runStatement(`ALTER TABLE dispensaciones ADD CONSTRAINT fk_disp_solicitud FOREIGN KEY (id_solicitud_dispensacion) REFERENCES solicitudes_dispensacion(id_solicitud_dispensacion)`);
  }
}

async function ensureTraceabilitySchema() {
  const prerequisites = (await Promise.all([
    tableExists('sedes'),
    tableExists('usuarios')
  ])).every(Boolean);

  if (!prerequisites) {
    return;
  }

  if (!(await tableExists('procesos_terminados_trazabilidad'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS procesos_terminados_trazabilidad (
          id_traza BIGINT AUTO_INCREMENT PRIMARY KEY,
          fecha_hora DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          proceso VARCHAR(80) NOT NULL,
          subproceso VARCHAR(80) DEFAULT NULL,
          estado ENUM('terminado','parcial','cancelado','error') NOT NULL DEFAULT 'terminado',
          id_sede INT DEFAULT NULL,
          id_usuario INT DEFAULT NULL,
          perfil_nombre VARCHAR(80) DEFAULT NULL,
          referencia_tipo VARCHAR(80) DEFAULT NULL,
          referencia_id BIGINT DEFAULT NULL,
          descripcion VARCHAR(255) DEFAULT NULL,
          payload_json JSON DEFAULT NULL,
          CONSTRAINT fk_trace_sede FOREIGN KEY (id_sede) REFERENCES sedes(id_sede),
          CONSTRAINT fk_trace_user FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario),
          INDEX idx_trace_fecha (fecha_hora),
          INDEX idx_trace_proc (proceso, subproceso),
          INDEX idx_trace_ref (referencia_tipo, referencia_id),
          INDEX idx_trace_sede (id_sede)
      ) ENGINE=InnoDB COMMENT='Traza operativa de procesos terminados por usuario/perfil'
    `);
  }

  await runStatement(`
    ALTER TABLE procesos_terminados_trazabilidad
      ADD COLUMN IF NOT EXISTS request_id VARCHAR(64) NULL AFTER id_traza,
      ADD COLUMN IF NOT EXISTS endpoint VARCHAR(255) NULL AFTER descripcion,
      ADD COLUMN IF NOT EXISTS http_method VARCHAR(10) NULL AFTER endpoint,
      ADD COLUMN IF NOT EXISTS http_status INT NULL AFTER http_method,
      ADD COLUMN IF NOT EXISTS duracion_ms INT NULL AFTER http_status,
      ADD COLUMN IF NOT EXISTS session_hash VARCHAR(64) NULL AFTER duracion_ms
  `);

  if (!(await indexExists('procesos_terminados_trazabilidad', 'idx_trace_request'))) {
    await runStatement('ALTER TABLE procesos_terminados_trazabilidad ADD INDEX idx_trace_request (request_id)');
  }
  if (!(await indexExists('procesos_terminados_trazabilidad', 'idx_trace_http'))) {
    await runStatement('ALTER TABLE procesos_terminados_trazabilidad ADD INDEX idx_trace_http (http_method, http_status)');
  }
}

async function ensureInventoryViews() {
  const prerequisites = (await Promise.all([
    tableExists('sedes'),
    tableExists('productos'),
    tableExists('existencias'),
    tableExists('lotes'),
    tableExists('almacenes')
  ])).every(Boolean);

  if (!prerequisites) {
    return;
  }

  await runStatement(`
    CREATE OR REPLACE VIEW vw_inventario_local_sede AS
    SELECT
        s.id_sede,
        s.codigo AS sede_codigo,
        s.nombre AS sede_nombre,
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.requiere_cadena_frio,
        ROUND(SUM(COALESCE(e.cantidad_disponible,0)),3) AS stock_disponible,
        ROUND(SUM(COALESCE(e.cantidad_reservada,0)),3) AS stock_reservado,
        ROUND(SUM(COALESCE(e.cantidad_cuarentena,0)),3) AS stock_cuarentena,
        COUNT(DISTINCT l.id_lote) AS lotes_activos,
        MIN(l.fecha_vencimiento) AS vencimiento_mas_proximo,
        ROUND(SUM(COALESCE(e.cantidad_disponible,0) * COALESCE(l.costo_unitario,0)),2) AS valor_costo,
        ROUND(SUM(COALESCE(e.cantidad_disponible,0) * COALESCE(l.precio_venta,0)),2) AS valor_venta
    FROM existencias e
    INNER JOIN lotes l ON l.id_lote = e.id_lote
    INNER JOIN productos p ON p.id_producto = l.id_producto
    INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
    INNER JOIN sedes s ON s.id_sede = a.id_sede
    GROUP BY s.id_sede, p.id_producto
  `);

  await runStatement(`
    CREATE OR REPLACE VIEW vw_inventario_general AS
    SELECT
        p.id_producto,
        p.sku,
        p.codigo_barras,
        p.nombre_comercial,
        p.principio_activo,
        p.concentracion,
        p.requiere_cadena_frio,
        ROUND(SUM(COALESCE(e.cantidad_disponible,0)),3) AS stock_disponible_total,
        ROUND(SUM(COALESCE(e.cantidad_reservada,0)),3) AS stock_reservado_total,
        ROUND(SUM(COALESCE(e.cantidad_cuarentena,0)),3) AS stock_cuarentena_total,
        COUNT(DISTINCT a.id_sede) AS sedes_con_stock,
        COUNT(DISTINCT l.id_lote) AS lotes_activos,
        MIN(l.fecha_vencimiento) AS vencimiento_mas_proximo,
        ROUND(SUM(COALESCE(e.cantidad_disponible,0) * COALESCE(l.costo_unitario,0)),2) AS valor_costo_total,
        ROUND(SUM(COALESCE(e.cantidad_disponible,0) * COALESCE(l.precio_venta,0)),2) AS valor_venta_total
    FROM existencias e
    INNER JOIN lotes l ON l.id_lote = e.id_lote
    INNER JOIN productos p ON p.id_producto = l.id_producto
    INNER JOIN almacenes a ON a.id_almacen = e.id_almacen
    GROUP BY p.id_producto
  `);
}

async function ensureProductionSchema() {
  if (await tableExists('log_auditoria')) {
    await runStatement(`
      ALTER TABLE log_auditoria
        ADD COLUMN IF NOT EXISTS perfil_nombre VARCHAR(120) NULL AFTER id_usuario,
        ADD COLUMN IF NOT EXISTS id_sede INT NULL AFTER perfil_nombre,
        ADD COLUMN IF NOT EXISTS metadata JSON DEFAULT NULL AFTER campos_modificados,
        ADD COLUMN IF NOT EXISTS request_id VARCHAR(64) NULL AFTER mensaje_error,
        ADD COLUMN IF NOT EXISTS endpoint VARCHAR(255) NULL AFTER request_id,
        ADD COLUMN IF NOT EXISTS http_method VARCHAR(10) NULL AFTER endpoint,
        ADD COLUMN IF NOT EXISTS http_status INT NULL AFTER http_method,
        ADD COLUMN IF NOT EXISTS severidad ENUM('info','warning','critical') NOT NULL DEFAULT 'info' AFTER http_status,
        ADD COLUMN IF NOT EXISTS session_hash VARCHAR(64) NULL AFTER severidad
    `);

    if (!(await indexExists('log_auditoria', 'idx_log_perfil'))) {
      await runStatement('ALTER TABLE log_auditoria ADD INDEX idx_log_perfil (perfil_nombre)');
    }
    if (!(await indexExists('log_auditoria', 'idx_log_sede'))) {
      await runStatement('ALTER TABLE log_auditoria ADD INDEX idx_log_sede (id_sede)');
    }
    if (!(await indexExists('log_auditoria', 'idx_log_request'))) {
      await runStatement('ALTER TABLE log_auditoria ADD INDEX idx_log_request (request_id)');
    }
    if (!(await indexExists('log_auditoria', 'idx_log_endpoint'))) {
      await runStatement('ALTER TABLE log_auditoria ADD INDEX idx_log_endpoint (endpoint(120))');
    }
    if (!(await indexExists('log_auditoria', 'idx_log_http_status'))) {
      await runStatement('ALTER TABLE log_auditoria ADD INDEX idx_log_http_status (http_status)');
    }
    if (!(await indexExists('log_auditoria', 'idx_log_severidad'))) {
      await runStatement('ALTER TABLE log_auditoria ADD INDEX idx_log_severidad (severidad)');
    }
  }

  const signPrereqs = (await Promise.all([
    tableExists('usuarios'),
    tableExists('sedes')
  ])).every(Boolean);

  if (signPrereqs && !(await tableExists('firmas_avanzadas_perfiles'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS firmas_avanzadas_perfiles (
          id_perfil_firma BIGINT AUTO_INCREMENT PRIMARY KEY,
          id_usuario INT NOT NULL,
          alias_certificado VARCHAR(120) NOT NULL,
          emisor_certificado VARCHAR(180) NULL,
          serial_certificado VARCHAR(120) NULL,
          huella_certificado VARCHAR(128) NULL,
          email_firma VARCHAR(180) NULL,
          pin_hash VARCHAR(255) NULL,
          exige_segundo_factor BOOLEAN DEFAULT FALSE,
          firma_visible_nombre VARCHAR(160) NULL,
          firma_visible_cargo VARCHAR(160) NULL,
          firma_visible_imagen LONGTEXT NULL,
          es_activo BOOLEAN DEFAULT TRUE,
          metadata JSON DEFAULT NULL,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          fecha_modificacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_firma_adv_usuario FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario) ON DELETE CASCADE,
          UNIQUE KEY uk_firma_adv_usuario (id_usuario)
      ) ENGINE=InnoDB COMMENT='Perfil de firma electrónica avanzada por usuario'
    `);
  }

  if (signPrereqs && !(await tableExists('firmas_transacciones'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS firmas_transacciones (
          id_firma_transaccion BIGINT AUTO_INCREMENT PRIMARY KEY,
          request_id VARCHAR(64) NULL,
          modulo VARCHAR(50) NOT NULL,
          submodulo VARCHAR(50) NULL,
          referencia_tipo VARCHAR(80) NULL,
          referencia_id VARCHAR(80) NULL,
          descripcion VARCHAR(255) NULL,
          payload_resumen_json JSON NOT NULL,
          payload_hash_sha256 CHAR(64) NOT NULL,
          firma_hmac_sha256 CHAR(64) NOT NULL,
          firmado_por_usuario_id INT NOT NULL,
          perfil_nombre VARCHAR(120) NULL,
          id_sede INT NULL,
          certificado_alias VARCHAR(120) NOT NULL,
          factor_validado ENUM('pin','password','mfa') NOT NULL DEFAULT 'pin',
          estado ENUM('firmada','revocada','expirada') NOT NULL DEFAULT 'firmada',
          fecha_firma TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_firma_tx_usuario FOREIGN KEY (firmado_por_usuario_id) REFERENCES usuarios(id_usuario),
          CONSTRAINT fk_firma_tx_sede FOREIGN KEY (id_sede) REFERENCES sedes(id_sede) ON DELETE SET NULL,
          INDEX idx_firma_tx_request (request_id),
          INDEX idx_firma_tx_modulo (modulo, submodulo),
          INDEX idx_firma_tx_fecha (fecha_firma)
      ) ENGINE=InnoDB COMMENT='Evidencia de firma avanzada por transacción'
    `);
  }

  if (!(await tableExists('backups_ejecuciones'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS backups_ejecuciones (
          id_backup BIGINT AUTO_INCREMENT PRIMARY KEY,
          tipo ENUM('logical','uploads','full') NOT NULL DEFAULT 'logical',
          archivo_principal VARCHAR(255) NOT NULL,
          checksum_sha256 CHAR(64) NULL,
          tamano_bytes BIGINT NULL,
          duracion_segundos INT NULL,
          destino VARCHAR(255) NULL,
          estado ENUM('ok','error','running') NOT NULL DEFAULT 'running',
          observaciones TEXT NULL,
          fecha_inicio DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          fecha_fin DATETIME NULL,
          creado_por VARCHAR(120) DEFAULT 'backup-service',
          INDEX idx_backup_estado (estado),
          INDEX idx_backup_fecha (fecha_inicio)
      ) ENGINE=InnoDB COMMENT='Histórico de backups automáticos'
    `);
  }
}

async function ensureRuntimeConfigFlags() {
  if (!(await tableExists('configuracion_sistema'))) {
    return;
  }

  await runStatement(`
    INSERT INTO configuracion_sistema (modulo, clave, valor, tipo_dato, descripcion)
    VALUES
      ('SCANNERS', 'auto_detect_habilitado', 'true', 'booleano', 'Habilita detección automática de lectores disponibles en frontend'),
      ('INVENTARIO', 'vista_general_multisede', 'true', 'booleano', 'Permite consultar inventario general consolidado'),
      ('DISPENSACION', 'solicitudes_habilitadas', 'true', 'booleano', 'Permite solicitudes manuales, API HCE y fórmula escaneada'),
      ('PRODUCCION', 'https_habilitado', 'true', 'booleano', 'Reverse proxy HTTPS habilitado en producción'),
      ('PRODUCCION', 'metricas_habilitadas', 'true', 'booleano', 'Endpoint /metrics expuesto para Prometheus'),
      ('PRODUCCION', 'backup_automatico_horas', '6', 'entero', 'Frecuencia de backups automáticos'),
      ('PRODUCCION', 'firma_avanzada_habilitada', 'true', 'booleano', 'Firma avanzada disponible para procesos críticos')
    ON DUPLICATE KEY UPDATE valor = VALUES(valor), descripcion = VALUES(descripcion)
  `);
}


async function insertRoleUsabilityForRoles(roleNames = [], item = {}) {
  if (!roleNames.length) {
    return;
  }
  const placeholders = roleNames.map(() => '?').join(', ');
  await runStatement(
    `INSERT INTO role_usabilities (id_rol, clave, nombre, descripcion, categoria, habilitado, metadata)
     SELECT r.id_rol, ?, ?, ?, ?, ?, ?
       FROM roles r
      WHERE r.nombre IN (${placeholders})
        AND NOT EXISTS (
          SELECT 1 FROM role_usabilities ru WHERE ru.id_rol = r.id_rol AND ru.clave = ?
        )`,
    [
      item.clave,
      item.nombre,
      item.descripcion ?? null,
      item.categoria ?? 'general',
      item.habilitado !== false,
      item.metadata ? JSON.stringify(item.metadata) : null,
      ...roleNames,
      item.clave
    ]
  );
}

async function ensureV19RoleUsabilities() {
  if (!(await tableExists('roles')) || !(await tableExists('role_usabilities'))) {
    return;
  }

  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'sites.manage',
    nombre: 'Gestor de sedes',
    descripcion: 'Crear y administrar sedes desde dashboard / centro operativo',
    categoria: 'multisede',
    metadata: { dashboard_entry: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'sites.delete',
    nombre: 'Eliminar sedes',
    descripcion: 'Desactivar sedes y sus estructuras operativas',
    categoria: 'multisede',
    metadata: { destructive: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'profiles.manage',
    nombre: 'Gestor de perfiles',
    descripcion: 'Crear, editar y eliminar perfiles del sistema',
    categoria: 'seguridad',
    metadata: { topbar_entry: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'profiles.assign',
    nombre: 'Adjudicar perfiles',
    descripcion: 'Asignar o reasignar perfiles y sedes a usuarios',
    categoria: 'seguridad',
    metadata: { topbar_entry: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR', 'GERENTE', 'COMPRAS'], {
    clave: 'requests.central.review',
    nombre: 'Revisar solicitudes de compra',
    descripcion: 'Atender solicitudes de sedes alternas desde sede central',
    categoria: 'compras',
    metadata: { alert_banner: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR', 'GERENTE', 'FARMACEUTICO', 'ALMACENISTA', 'AUXILIAR_FARMACIA'], {
    clave: 'requests.branch.create',
    nombre: 'Solicitar items a central',
    descripcion: 'Crear solicitudes de abastecimiento hacia sede central',
    categoria: 'compras',
    metadata: { dashboard_entry: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR', 'GERENTE', 'FARMACEUTICO', 'ALMACENISTA', 'AUXILIAR_FARMACIA', 'QUIMICO_FARMACEUTICO', 'CAJERO', 'COMPRAS', 'AUDITOR'], {
    clave: 'auth.site.switch',
    nombre: 'Cambiar sede activa',
    descripcion: 'Seleccionar una sede autorizada al iniciar sesión',
    categoria: 'seguridad',
    metadata: { required_on_login: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'dashboard.site.manager',
    nombre: 'Dashboard gestor multisede',
    descripcion: 'Acceso a widgets de sedes y perfiles en dashboard',
    categoria: 'dashboard',
    metadata: { dashboard_entry: true }
  });
}


async function ensureV20RoleUsabilities() {
  if (!(await tableExists('roles')) || !(await tableExists('role_usabilities'))) {
    return;
  }

  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'users.manage',
    nombre: 'Gestor de usuarios',
    descripcion: 'Crear, editar, activar y desactivar usuarios desde el centro de control',
    categoria: 'seguridad',
    metadata: { dashboard_entry: true, operational: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'users.delete',
    nombre: 'Eliminar usuarios',
    descripcion: 'Desactivar usuarios y suspender el acceso',
    categoria: 'seguridad',
    metadata: { destructive: true }
  });
  await insertRoleUsabilityForRoles(['ADMINISTRADOR'], {
    clave: 'dashboard.control.center',
    nombre: 'Centro de control',
    descripcion: 'Habilita el centro de control totalmente operativo dentro del dashboard',
    categoria: 'dashboard',
    metadata: { embedded: true, dashboard_entry: true }
  });
}

async function ensureV19PurchaseRequestSchema() {
  const prerequisites = (await Promise.all([
    tableExists('sedes'),
    tableExists('usuarios'),
    tableExists('productos')
  ])).every(Boolean);

  if (!prerequisites) {
    return;
  }

  if (!(await tableExists('solicitudes_compra_sedes'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS solicitudes_compra_sedes (
          id_solicitud_compra_sede BIGINT AUTO_INCREMENT PRIMARY KEY,
          consecutivo VARCHAR(30) NOT NULL UNIQUE,
          estado ENUM('pendiente','revisada','aprobada','rechazada','atendida','cancelada') NOT NULL DEFAULT 'pendiente',
          prioridad ENUM('baja','media','alta','critica') NOT NULL DEFAULT 'media',
          id_sede_origen INT NOT NULL,
          id_sede_central INT NOT NULL,
          id_usuario_solicita INT NOT NULL,
          id_usuario_revision INT DEFAULT NULL,
          observaciones TEXT DEFAULT NULL,
          metadata JSON DEFAULT NULL,
          fecha_solicitud DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          fecha_revision DATETIME DEFAULT NULL,
          fecha_modificacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_req_compra_sede_origen FOREIGN KEY (id_sede_origen) REFERENCES sedes(id_sede),
          CONSTRAINT fk_req_compra_sede_central FOREIGN KEY (id_sede_central) REFERENCES sedes(id_sede),
          CONSTRAINT fk_req_compra_usuario_sol FOREIGN KEY (id_usuario_solicita) REFERENCES usuarios(id_usuario),
          CONSTRAINT fk_req_compra_usuario_rev FOREIGN KEY (id_usuario_revision) REFERENCES usuarios(id_usuario),
          INDEX idx_req_compra_estado (estado),
          INDEX idx_req_compra_sede_origen (id_sede_origen),
          INDEX idx_req_compra_sede_central (id_sede_central),
          INDEX idx_req_compra_fecha (fecha_solicitud)
      ) ENGINE=InnoDB COMMENT='Solicitudes de abastecimiento de sedes periféricas hacia la sede central'
    `);
  }

  if (!(await tableExists('solicitudes_compra_sedes_detalle'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS solicitudes_compra_sedes_detalle (
          id_solicitud_compra_detalle BIGINT AUTO_INCREMENT PRIMARY KEY,
          id_solicitud_compra_sede BIGINT NOT NULL,
          id_producto INT DEFAULT NULL,
          descripcion_item VARCHAR(255) NOT NULL,
          cantidad_solicitada DECIMAL(14,3) NOT NULL,
          cantidad_atendida DECIMAL(14,3) NOT NULL DEFAULT 0,
          stock_local DECIMAL(14,3) DEFAULT NULL,
          stock_general DECIMAL(14,3) DEFAULT NULL,
          observaciones VARCHAR(255) DEFAULT NULL,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT fk_req_compra_det_header FOREIGN KEY (id_solicitud_compra_sede) REFERENCES solicitudes_compra_sedes(id_solicitud_compra_sede) ON DELETE CASCADE,
          CONSTRAINT fk_req_compra_det_producto FOREIGN KEY (id_producto) REFERENCES productos(id_producto),
          INDEX idx_req_compra_det_prod (id_producto)
      ) ENGINE=InnoDB COMMENT='Detalle item por item de solicitudes de compra / abastecimiento entre sedes'
    `);
  }

  if (!(await tableExists('sedes'))) {
    return;
  }

  await runStatement(`
    ALTER TABLE sedes
      ADD COLUMN IF NOT EXISTS creado_por INT NULL AFTER fecha_modificacion,
      ADD COLUMN IF NOT EXISTS eliminado_en DATETIME NULL AFTER creado_por,
      ADD COLUMN IF NOT EXISTS eliminado_por INT NULL AFTER eliminado_en
  `);
}

async function ensureIngresosSchema() {
  const hasUsuarios = await tableExists('usuarios');

  if (!(await tableExists('ingresos'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS ingresos (
        id_ingreso        INT AUTO_INCREMENT PRIMARY KEY,
        referencia        VARCHAR(120) NOT NULL,
        producto          LONGTEXT NOT NULL,
        cantidad          DECIMAL(12,3) NOT NULL DEFAULT 0,
        lote              VARCHAR(80) NULL,
        fecha_vencimiento DATE NULL,
        estado            ENUM('pendiente','recibido','almacenado','cancelado') NOT NULL DEFAULT 'pendiente',
        fecha_ingreso     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        creado_por        INT NULL,
        created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ingresos_referencia  (referencia),
        INDEX idx_ingresos_estado      (estado),
        INDEX idx_ingresos_fecha       (fecha_ingreso),
        INDEX idx_ingresos_creado_por  (creado_por)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Ingresos Sebas: recepciones de mercancía y devoluciones'
    `);
    console.log('[schema] Tabla ingresos creada en runtime');
  }

  if (hasUsuarios && !(await columnExists('ingresos', 'creado_por'))) {
    await runStatement(`ALTER TABLE ingresos ADD COLUMN creado_por INT NULL AFTER fecha_ingreso`);
  }

  if (hasUsuarios && !(await constraintExists('ingresos', 'fk_ingresos_creado_por'))) {
    await tryStep('fk_ingresos_creado_por', () =>
      runStatement(`
        ALTER TABLE ingresos
          ADD CONSTRAINT fk_ingresos_creado_por
            FOREIGN KEY (creado_por) REFERENCES usuarios(id_usuario)
            ON DELETE SET NULL ON UPDATE CASCADE
      `)
    );
  }

  if (await columnExists('productos', 'es_controlado')) {
    await runStatement(`ALTER TABLE productos DROP COLUMN es_controlado`);
    console.log('[schema] Columna es_controlado eliminada de productos');
  }

  if (!(await columnExists('productos', 'codigo_dci'))) {
    await runStatement(`ALTER TABLE productos ADD COLUMN codigo_dci VARCHAR(255) NULL AFTER codigo_atc`);
    console.log('[schema] Columna codigo_dci agregada a productos');
  }

  // Convertir presentacion a INT si aún es VARCHAR/TEXT
  const [presentColRows] = await query(
    `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productos' AND COLUMN_NAME = 'presentacion'`
  );
  if (presentColRows && presentColRows.DATA_TYPE && !['int','bigint','smallint','tinyint','mediumint'].includes(presentColRows.DATA_TYPE.toLowerCase())) {
    await runStatement(`ALTER TABLE productos MODIFY COLUMN presentacion INT NULL`);
    console.log('[schema] Columna presentacion convertida a INT');
  }

  // Convertir codigo_dci a INT si aún es VARCHAR/TEXT
  const [dciColRows] = await query(
    `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productos' AND COLUMN_NAME = 'codigo_dci'`
  );
  if (dciColRows && dciColRows.DATA_TYPE && !['int','bigint','smallint','tinyint','mediumint'].includes(dciColRows.DATA_TYPE.toLowerCase())) {
    await runStatement(`ALTER TABLE productos MODIFY COLUMN codigo_dci INT NULL`);
    console.log('[schema] Columna codigo_dci convertida a INT');
  }

  // Convertir consecutivo_cum a INT si aún es VARCHAR/TEXT
  const [cumColRows] = await query(
    `SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'productos' AND COLUMN_NAME = 'consecutivo_cum'`
  );
  if (cumColRows && cumColRows.DATA_TYPE && !['int','bigint','smallint','tinyint','mediumint'].includes(cumColRows.DATA_TYPE.toLowerCase())) {
    await runStatement(`ALTER TABLE productos MODIFY COLUMN consecutivo_cum INT NULL`);
    console.log('[schema] Columna consecutivo_cum convertida a INT');
  }

  // ── Columnas estructuradas en ingresos (migración automática) ──────────────
  if (!(await columnExists('ingresos', 'prefijo_factura'))) {
    await runStatement(`
      ALTER TABLE ingresos
        ADD COLUMN IF NOT EXISTS prefijo_factura     VARCHAR(20)   NULL,
        ADD COLUMN IF NOT EXISTS numero_factura      VARCHAR(50)   NULL,
        ADD COLUMN IF NOT EXISTS cufe                VARCHAR(255)  NULL,
        ADD COLUMN IF NOT EXISTS fecha_recepcion     DATE          NULL,
        ADD COLUMN IF NOT EXISTS observaciones       TEXT          NULL,
        ADD COLUMN IF NOT EXISTS numero_orden_compra VARCHAR(100)  NULL,
        ADD COLUMN IF NOT EXISTS sede                VARCHAR(200)  NULL,
        ADD COLUMN IF NOT EXISTS bodega              VARCHAR(200)  NULL,
        ADD COLUMN IF NOT EXISTS proveedor_nombre    VARCHAR(200)  NULL,
        ADD COLUMN IF NOT EXISTS proveedor_nit       VARCHAR(50)   NULL,
        ADD COLUMN IF NOT EXISTS proveedor_contacto  VARCHAR(200)  NULL,
        ADD COLUMN IF NOT EXISTS proveedor_telefono  VARCHAR(50)   NULL,
        ADD COLUMN IF NOT EXISTS proveedor_direccion VARCHAR(300)  NULL,
        ADD COLUMN IF NOT EXISTS total_bruto         DECIMAL(15,2) NULL,
        ADD COLUMN IF NOT EXISTS total_descuento     DECIMAL(15,2) NULL,
        ADD COLUMN IF NOT EXISTS subtotal_neto       DECIMAL(15,2) NULL,
        ADD COLUMN IF NOT EXISTS total_iva           DECIMAL(15,2) NULL,
        ADD COLUMN IF NOT EXISTS total_ingreso       DECIMAL(15,2) NULL
    `);
    console.log('[schema] Columnas estructuradas agregadas a ingresos');
  }

  // ── Tabla ingresos_items ───────────────────────────────────────────────────
  if (!(await tableExists('ingresos_items'))) {
    await runStatement(`
      CREATE TABLE IF NOT EXISTS ingresos_items (
        id_item            INT           NOT NULL AUTO_INCREMENT,
        id_ingreso         INT           NOT NULL,
        codigo             VARCHAR(100)  NULL,
        nombre             VARCHAR(300)  NULL,
        laboratorio        VARCHAR(200)  NULL,
        cantidad           DECIMAL(15,4) NOT NULL DEFAULT 0,
        valor_unitario     DECIMAL(15,4) NOT NULL DEFAULT 0,
        descuento_pct      DECIMAL(8,4)  NOT NULL DEFAULT 0,
        descuento_valor    DECIMAL(15,2) NOT NULL DEFAULT 0,
        iva                DECIMAL(8,4)  NOT NULL DEFAULT 0,
        lote               VARCHAR(100)  NULL,
        fecha_vencimiento  DATE          NULL,
        registro_invima    VARCHAR(100)  NULL,
        cum                VARCHAR(100)  NULL,
        consecutivo_cum    VARCHAR(100)  NULL,
        presentacion       VARCHAR(200)  NULL,
        temperatura        VARCHAR(100)  NULL,
        cumple             TINYINT(1)    NULL,
        PRIMARY KEY (id_item),
        CONSTRAINT fk_ingresos_items_ingreso
          FOREIGN KEY (id_ingreso) REFERENCES ingresos(id_ingreso)
          ON DELETE CASCADE,
        INDEX idx_ingresos_items_ingreso (id_ingreso)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        COMMENT='Items detallados de cada ingreso Sebas'
    `);
    console.log('[schema] Tabla ingresos_items creada en runtime');
  }
}

async function runEnsureRuntimeSchema() {
  console.log('[schema] verificando compatibilidad de esquema en runtime');

  await tryStep('role_usabilities', ensureRoleUsabilities);
  await tryStep('barcode_scanners', ensureBarcodeScannerSchema);
  await tryStep('dispensing_requests', ensureDispensingRequestSchema);
  await tryStep('traceability', ensureTraceabilitySchema);
  await tryStep('inventory_views', ensureInventoryViews);
  await tryStep('production_schema', ensureProductionSchema);
  await tryStep('config_flags', ensureRuntimeConfigFlags);
  await tryStep('v19_role_usabilities', ensureV19RoleUsabilities);
  await tryStep('v20_role_usabilities', ensureV20RoleUsabilities);
  await tryStep('v19_purchase_requests', ensureV19PurchaseRequestSchema);
  await tryStep('ingresos_sebas', ensureIngresosSchema);

  console.log('[schema] verificación de compatibilidad completada');
}

export async function ensureRuntimeSchema(options = {}) {
  const { force = false } = options;
  if (!ensurePromise || force) {
    ensurePromise = runEnsureRuntimeSchema().catch((error) => {
      ensurePromise = null;
      throw error;
    });
  }
  return ensurePromise;
}

export async function tableAvailable(tableName) {
  return tableExists(tableName);
}
