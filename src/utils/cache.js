const store = new Map();

/**
 * Get cached value or compute it via fn(), store with TTL (ms).
 * @param {string} key
 * @param {() => Promise<any>} fn
 * @param {number} ttlMs
 */
export async function cached(key, fn, ttlMs = 60_000) {
  const entry = store.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.value;
  }
  const value = await fn();
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Invalidate one or all cache entries. */
export function invalidate(key) {
  if (key) {
    store.delete(key);
  } else {
    store.clear();
  }
}
