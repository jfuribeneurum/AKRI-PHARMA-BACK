import { app } from './app.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { startColdChainAutoPolling } from './services/cold-chain-autopoll.service.js';
import { ensureRuntimeSchema } from './services/runtime-schema.service.js';
import { initParametrosTable } from './services/parametros.service.js';
import { logger } from './utils/logger.js';

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
      logger.info({ attempt, host: env.DB_HOST, port: env.DB_PORT }, 'MariaDB disponible');
      return;
    } catch (error) {
      if (connection) {
        connection.release();
      }

      lastError = error;
      logger.warn({ attempt, max: env.DB_STARTUP_MAX_ATTEMPTS, err: error.message }, 'Esperando MariaDB');

      if (attempt < env.DB_STARTUP_MAX_ATTEMPTS) {
        await sleep(Math.max(250, env.DB_STARTUP_DELAY_MS));
      }
    }
  }

  throw lastError ?? new Error('No fue posible conectar con MariaDB durante el arranque');
}

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);

    server.once('listening', () => resolve({ server, port }));
    server.once('error', (error) => reject(error));
  });
}

async function startServer(port, maxRetries = 10) {
  let attemptPort = port;

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const result = await listenOnPort(attemptPort);
      return result.port;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error;
      }

      logger.warn({ port: attemptPort }, attempt < maxRetries - 1 ? 'Puerto ocupado, intentando siguiente' : 'Puerto ocupado');
      attemptPort += 1;
    }
  }

  throw new Error(`No fue posible abrir un puerto libre entre ${port} y ${port + maxRetries - 1}`);
}

async function start() {
  try {
    await waitForDatabase();
    await ensureRuntimeSchema();
    await initParametrosTable();

    const activePort = await startServer(env.PORT);
    logger.info({ port: activePort }, 'AkriPharmacy backend listo');
    startColdChainAutoPolling();
  } catch (error) {
    logger.fatal({ err: error.message }, 'Error fatal al iniciar el backend');
    process.exit(1);
  }
}

void start();
