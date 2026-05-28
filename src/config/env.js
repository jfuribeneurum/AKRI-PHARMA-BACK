import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config();

const parseCsv = (value) => String(value ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function parseTrustProxy(value) {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  TRUST_PROXY: parseTrustProxy(process.env.TRUST_PROXY ?? 'false'),
  DB_HOST: process.env.DB_HOST ?? 'localhost',
  DB_PORT: Number(process.env.DB_PORT ?? 3306),
  DB_USER: process.env.DB_USER ?? 'root',
  DB_PASSWORD: process.env.DB_PASSWORD ?? '',
  DB_NAME: process.env.DB_NAME ?? 'akripharmacy',
  JWT_SECRET: process.env.JWT_SECRET ?? 'change_this_secret',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '12h',
  CORS_ORIGIN: parseCsv(process.env.CORS_ORIGIN ?? ''),
  ALLOW_STOCK_NEGATIVE: String(process.env.ALLOW_STOCK_NEGATIVE ?? 'false') === 'true',
  SIESA_MOCK_MODE: String(process.env.SIESA_MOCK_MODE ?? 'true') === 'true',
  SIESA_TIMEOUT_MS: Number(process.env.SIESA_TIMEOUT_MS ?? 15000),
  MAX_IMAGE_SIZE_MB: Number(process.env.MAX_IMAGE_SIZE_MB ?? 8),
  UPLOAD_DIR: process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), 'public', 'uploads'),
  PUBLIC_UPLOAD_BASE_URL: process.env.PUBLIC_UPLOAD_BASE_URL ?? '/uploads',
  COLD_CHAIN_AUTOPOLL_ENABLED: String(process.env.COLD_CHAIN_AUTOPOLL_ENABLED ?? 'true') === 'true',
  COLD_CHAIN_AUTOPOLL_INTERVAL_MS: Number(process.env.COLD_CHAIN_AUTOPOLL_INTERVAL_MS ?? 60000),
  COLD_CHAIN_ALLOW_INSECURE_TLS: String(process.env.COLD_CHAIN_ALLOW_INSECURE_TLS ?? 'false') === 'true',
  DB_STARTUP_MAX_ATTEMPTS: Number(process.env.DB_STARTUP_MAX_ATTEMPTS ?? 30),
  DB_STARTUP_DELAY_MS: Number(process.env.DB_STARTUP_DELAY_MS ?? 2000),
  METRICS_ENABLED: String(process.env.METRICS_ENABLED ?? 'true') === 'true',
  METRICS_TOKEN: process.env.METRICS_TOKEN ?? '',
  REQUEST_TRACE_ENABLED: String(process.env.REQUEST_TRACE_ENABLED ?? 'true') === 'true',
  REQUEST_TRACE_EXCLUDE_PATHS: parseCsv(process.env.REQUEST_TRACE_EXCLUDE_PATHS ?? '/api/health,/api/ready,/healthz,/metrics'),
  SIGNATURE_ENFORCE_PIN: String(process.env.SIGNATURE_ENFORCE_PIN ?? 'true') === 'true',
  SIGNATURE_HASH_SALT: process.env.SIGNATURE_HASH_SALT ?? 'akripharmacy-signature-salt',
  APP_BASE_URL: process.env.APP_BASE_URL ?? 'http://localhost:8080',
  BACKUP_DIR: process.env.BACKUP_DIR ?? path.resolve(process.cwd(), 'backups')
};
