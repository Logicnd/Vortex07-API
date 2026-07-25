import { getRedis } from "./redis.js";
import { clientKeyFromRequest, hitReadLimit } from "./rate-limit.js";

/**
 * Soft-cap hot GETs. Returns a Response if limited, else null.
 * @param {Request} request
 * @param {string} bucket
 * @param {{ max?: number, windowSec?: number, actorId?: string|number|null }} [opts]
 */
export async function guardRead(request, bucket, opts = {}) {
  const actor =
    opts.actorId != null && String(opts.actorId).trim()
      ? String(opts.actorId).trim()
      : clientKeyFromRequest(request);
  try {
    const db = await getRedis();
    const hit = await hitReadLimit(db, `rl:get:${bucket}:${actor}`, {
      max: opts.max ?? 45,
      windowSec: opts.windowSec ?? 60,
    });
    if (!hit.limited) return null;
    return Response.json(
      {
        ok: false,
        error: "rate-limited",
        retryAfter: hit.retryAfterSec,
      },
      {
        status: 429,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Retry-After": String(hit.retryAfterSec || 1),
        },
      },
    );
  } catch (err) {
    // Don't take the API down if Redis rate-limit itself fails.
    console.error("read-guard failed", err);
    return null;
  }
}
