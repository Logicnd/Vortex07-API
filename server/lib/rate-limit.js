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

/**
 * Sliding window counter — soft cap for hot GETs.
 * @param {import('redis').RedisClientType} db
 */
export async function hitReadLimit(db, key, { max = 40, windowSec = 60 } = {}) {
  const limit = Math.max(1, Number(max) || 40);
  const ttl = Math.max(1, Number(windowSec) || 60);
  const n = Number(await db.incr(key)) || 0;
  if (n === 1) await db.expire(key, ttl);
  if (n > limit) {
    const left = Number(await db.ttl(key));
    return {
      limited: true,
      retryAfterSec: left > 0 ? left : ttl,
    };
  }
  return { limited: false, retryAfterSec: 0 };
}

/** Best-effort client key from Vercel / proxy headers. */
export function clientKeyFromRequest(request, fallback = "anon") {
  try {
    const h = request?.headers;
    const xf = String(h?.get?.("x-forwarded-for") || "").split(",")[0].trim();
    if (xf) return xf.slice(0, 80);
    const real = String(h?.get?.("x-real-ip") || "").trim();
    if (real) return real.slice(0, 80);
  } catch {
    /* ignore */
  }
  return fallback;
}
