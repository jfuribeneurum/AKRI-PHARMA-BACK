#!/bin/sh
set -eu

cd /app
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
CURRENT_HASH="$(cat node_modules/.akri-lock-hash 2>/dev/null || true)"

npm config set registry "$REGISTRY" >/dev/null 2>&1 || true

if [ ! -d node_modules ] || [ "$LOCK_HASH" != "$CURRENT_HASH" ]; then
  echo "[runtime] Instalando dependencias del backend desde $REGISTRY"
  rm -rf node_modules
  npm ci --omit=dev --no-fund --no-audit --registry="$REGISTRY"
  mkdir -p node_modules
  printf '%s' "$LOCK_HASH" > node_modules/.akri-lock-hash
else
  echo "[runtime] Dependencias del backend ya preparadas"
fi

mkdir -p uploads
exec npm run start
