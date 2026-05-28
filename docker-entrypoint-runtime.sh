#!/bin/sh
set -eu

REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
LOCK_HASH="$(sha256sum package-lock.json | awk '{print $1}')"
INSTALLED_HASH=""

if [ -f /app/node_modules/.akripharmacy-lock-hash ]; then
  INSTALLED_HASH="$(cat /app/node_modules/.akripharmacy-lock-hash || true)"
fi

if [ ! -d /app/node_modules ] || [ "$LOCK_HASH" != "$INSTALLED_HASH" ]; then
  echo "[runtime] instalando dependencias backend desde ${REGISTRY}"
  npm config set registry "$REGISTRY"
  npm ci --omit=dev --no-fund --no-audit --registry="$REGISTRY"
  mkdir -p /app/node_modules
  printf '%s' "$LOCK_HASH" > /app/node_modules/.akripharmacy-lock-hash
else
  echo "[runtime] dependencias backend ya presentes"
fi

mkdir -p /app/uploads
exec npm run start
