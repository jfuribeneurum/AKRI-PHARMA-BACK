import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { startColdChainAutoPolling } from './services/cold-chain-autopoll.service.js';
import { ensureRuntimeSchema } from './services/runtime-schema.service.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase() {
  let lastError;

  for (let attempt = 1; attempt <= Math.max(1, env.DB_STARTUP_MAX_ATTEMPTS); attempt += 1) {
    let connection;

    try {
      connection = await pool.getConnection();
      await connection.ping();
      await connection.query('SELECT 1 AS ok');
      connection.release();
      console.log(`[startup] MariaDB disponible en ${env.DB_HOST}:${env.DB_PORT} (intento ${attempt}/${env.DB_STARTUP_MAX_ATTEMPTS})`);
      return;
    } catch (error) {
      if (connection) {
        connection.release();
      }

      lastError = error;
      console.error(
        `[startup] Esperando MariaDB (${attempt}/${env.DB_STARTUP_MAX_ATTEMPTS}): ${error.message}`
      );

      if (attempt < env.DB_STARTUP_MAX_ATTEMPTS) {
        await sleep(Math.max(250, env.DB_STARTUP_DELAY_MS));
      }
    }
  }

  throw lastError ?? new Error('No fue posible conectar con MariaDB durante el arranque');
}

async function start() {
  try {
    await waitForDatabase();
    await ensureRuntimeSchema();

    app.listen(env.PORT, () => {
      console.log(`AkriPharmacy backend escuchando en puerto ${env.PORT}`);
      startColdChainAutoPolling();
    });
  } catch (error) {
    console.error('[startup] Error fatal al conectar con MariaDB:', error.message);
    process.exit(1);
  }
}

void start();
