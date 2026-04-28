import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { syncIntegration } from './cold-chain.service.js';

let started = false;
let running = false;

async function executeCycle() {
  if (running) {
    return;
  }

  running = true;
  try {
    const integrations = await query(
      `SELECT *
       FROM termohigrometro_integraciones
       WHERE activo = TRUE
         AND protocolo IN ('http_json', 'mqtt_bridge', 'modbus_gateway')`
    );

    const now = Date.now();

    for (const integration of integrations) {
      const lastSync = integration.ultima_sincronizacion ? new Date(integration.ultima_sincronizacion).getTime() : 0;
      const intervalMs = Math.max(30, Number(integration.polling_interval_segundos ?? 300)) * 1000;
      const due = !lastSync || (now - lastSync) >= intervalMs;

      if (!due) {
        continue;
      }

      try {
        await syncIntegration(integration.id_integracion, null);
      } catch (error) {
        console.error(`[cold-chain-autopoll] ${integration.nombre}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[cold-chain-autopoll] ciclo fallido:', error.message);
  } finally {
    running = false;
  }
}

export function startColdChainAutoPolling() {
  if (started || !env.COLD_CHAIN_AUTOPOLL_ENABLED) {
    return;
  }

  started = true;
  void executeCycle();
  setInterval(() => {
    void executeCycle();
  }, Math.max(30000, env.COLD_CHAIN_AUTOPOLL_INTERVAL_MS)).unref?.();

  console.log('[cold-chain-autopoll] activado');
}
