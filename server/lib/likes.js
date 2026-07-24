import { Redis } from "@upstash/redis";

function redis() {
  // Vercel KV / Upstash: KV_REST_API_URL + KV_REST_API_TOKEN
  // or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
  return Redis.fromEnv();
}

function key(targetId) {
  return `likes:${targetId}`;
}

export function parseUserId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export async function getLikeStatus(targetId, actorId) {
  const db = redis();
  const k = key(targetId);
  const count = Number(await db.scard(k)) || 0;
  let liked = false;
  if (actorId !== null) {
    liked = Boolean(await db.sismember(k, String(actorId)));
  }
  return {
    targetId,
    count,
    liked,
    myVote: liked ? "up" : null,
  };
}

export async function toggleLike(targetId, actorId) {
  if (actorId === targetId) {
    return { ok: false, reason: "self", status: 400 };
  }

  const db = redis();
  const k = key(targetId);
  const member = String(actorId);
  const already = Boolean(await db.sismember(k, member));

  if (already) {
    await db.srem(k, member);
  } else {
    await db.sadd(k, member);
  }

  const status = await getLikeStatus(targetId, actorId);
  return { ok: true, ...status };
}
