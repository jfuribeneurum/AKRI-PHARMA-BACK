// Supervisor para desarrollo local. `node --watch` reinicia el servidor
// cuando cambia un archivo, pero internamente corre el script en un
// proceso hijo separado: si ese hijo muere por su cuenta (crash, corte de
// red hacia la DB, bug del watcher en Windows), `node --watch` se queda
// esperando un cambio de archivo en vez de relanzarlo — el backend queda
// caído indefinidamente. Este script reemplaza a `node --watch` por
// completo: corre server.js directamente y controla tanto el reinicio por
// cambio de archivo como el reinicio por caída, sin depender de node.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';

const ENTRY = 'src/server.js';
const WATCH_DIR = 'src';
const MIN_UPTIME_MS = 3000;
const RESTART_DELAY_MS = 500;
const DEBOUNCE_MS = 300;

let child = null;
let startedAt = 0;
let restarting = false;
let debounceTimer = null;

function startChild() {
  startedAt = Date.now();
  child = spawn(process.execPath, [ENTRY], { stdio: 'inherit', env: process.env });

  child.on('exit', (code, signal) => {
    child = null;
    if (restarting) {
      restarting = false;
      startChild();
      return;
    }

    const uptime = Date.now() - startedAt;
    console.log(
      `\n[dev-watch] servidor terminó (code=${code} signal=${signal}, activo ${uptime}ms). Reiniciando...\n`
    );
    const delay = uptime < MIN_UPTIME_MS ? RESTART_DELAY_MS * 4 : RESTART_DELAY_MS;
    setTimeout(startChild, delay);
  });
}

function restartForFileChange(filename) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`\n[dev-watch] cambio detectado (${filename ?? 'src/'}). Reiniciando...\n`);
    if (child) {
      restarting = true;
      child.kill();
    } else {
      startChild();
    }
  }, DEBOUNCE_MS);
}

watch(WATCH_DIR, { recursive: true }, (_event, filename) => restartForFileChange(filename));

startChild();
