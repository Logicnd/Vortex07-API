/** Shared Redis rate limits for Vortex07 extension API routes. */

/** @param {import('redis').RedisClientType} db */
export async function checkRateLimit(db, key, windowMs) {
  const ms = Math.max(1, Number(windowMs) || 1000);
  const last = await db.get(key);
  if (last) {
    const elapsed = Date.now() - Number(last);
    if (elapsed >= 0 && elapsed < ms) {
      return {
        limited: true,
        retryAfterMs: ms - elapsed,
        retryAfterSec: Math.max(1, Math.ceil((ms - elapsed) / 1000)),
      };
    }
  }
  return { limited: false, retryAfterMs: 0, retryAfterSec: 0 };
}

/** @param {import('redis').RedisClientType} db */
export async function markRateLimit(db, key, windowMs) {
  const ms = Math.max(1, Number(windowMs) || 1000);
  await db.set(key, String(Date.now()), { PX: ms });
}

/**
 * Atomic check+mark. Returns limited:true if caller should back off.
 * @param {import('redis').RedisClientType} db
 */
export async function hitRateLimit(db, key, windowMs) {
  const check = await checkRateLimit(db, key, windowMs);
  if (check.limited) return check;
  await markRateLimit(db, key, windowMs);
  return { limited: false, retryAfterMs: 0, retryAfterSec: 0 };
}
