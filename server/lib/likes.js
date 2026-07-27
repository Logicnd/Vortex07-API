import { getRedis } from "./redis.js";
import { clientKeyFromRequest, hitReadLimit } from "./rate-limit.js";
import {
  parseUserId,
  resolveAuthor,
  sessionCookieFrom,
  writeProofFrom,
} from "./identity.js";

function key(targetId) {
  return `likes:${targetId}`;
}

function bonusKey(targetId) {
  return `likes:bonus:${targetId}`;
}

export { parseUserId };

/** Drop targetId from its own like set — same id can never count as a like. */
async function stripSelfLike(db, targetId) {
  const target = parseUserId(targetId);
  if (target === null) return false;
  const removed = await db.sRem(key(target), String(target));
  return Number(removed) > 0;
}

/**
 * Legacy likes:bonus:* inflated counts (old whitelist / stacked spoof).
 * Never count them in public totals anymore.
 */
export async function scrubLikeBonuses() {
  const db = await getRedis();
  const deleted = [];
  let cursor = 0;
  do {
    const res = await db.scan(cursor, { MATCH: "likes:bonus:*", COUNT: 200 });
    cursor = Number(res.cursor) || 0;
    const keys = res.keys || [];
    for (const k of keys) {
      await db.del(k);
      deleted.push(k);
    }
  } while (cursor !== 0);
  return { ok: true, deleted: deleted.length, keys: deleted.slice(0, 50) };
}

/**
 * Remove every self-like (member id === profile id) across likes:* sets.
 * Admins included — nobody can like their own profile.
 */
export async function scrubSelfLikes() {
  const db = await getRedis();
  const scrubbed = [];
  let cursor = 0;
  do {
    const res = await db.scan(cursor, { MATCH: "likes:*", COUNT: 200 });
    cursor = Number(res.cursor) || 0;
    for (const k of res.keys || []) {
      if (k.startsWith("likes:bonus:")) continue;
      const m = String(k).match(/^likes:(\d+)$/);
      if (!m) continue;
      const targetId = m[1];
      const removed = Number(await db.sRem(k, targetId)) || 0;
      if (removed > 0) scrubbed.push({ targetId: Number(targetId), removed });
    }
  } while (cursor !== 0);
  return { ok: true, scrubbed: scrubbed.length, details: scrubbed.slice(0, 100) };
}

/** Wipe the real like set for a profile (mod cleanup after spoof dumps). */
export async function resetProfileLikes(targetId) {
  const target = parseUserId(targetId);
  if (target === null) return { ok: false, error: "bad-target", status: 400 };
  const db = await getRedis();
  const k = key(target);
  const before = Number(await db.sCard(k)) || 0;
  await db.del(k);
  await db.del(bonusKey(target));
  return { ok: true, targetId: target, removed: before };
}

export async function getLikeStatus(targetId, actorId) {
  const db = await getRedis();
  const target = parseUserId(targetId);
  if (target === null) {
    return { targetId: null, count: 0, liked: false, myVote: null };
  }
  const k = key(target);
  // Never allow self-like to linger or inflate the count.
  await stripSelfLike(db, target);
  // Bonus intentionally ignored — legacy spoof vector.
  const count = Number(await db.sCard(k)) || 0;
  const actor = parseUserId(actorId);
  let liked = false;
  if (actor !== null && actor !== target) {
    liked = Boolean(await db.sIsMember(k, String(actor)));
  }
  return {
    targetId: target,
    count,
    liked,
    myVote: liked ? "up" : null,
  };
}

/**
 * Resolve actor for a like write.
 * Session cookie or HMAC write proof only — never trust client actorId.
 */
export async function resolveLikeActor(request, body = {}) {
  const identity = await resolveAuthor({
    authorId: body?.actorId,
    sessionCookie: sessionCookieFrom(request, body),
    writeProof: writeProofFrom(request, body),
    requireSession: true,
  });
  if (!identity.ok) return identity;
  return { ok: true, actorId: identity.authorId, source: identity.source };
}

async function guardLikeWrite(request, actorId) {
  const db = await getRedis();
  const ip = clientKeyFromRequest(request);
  const ipHit = await hitReadLimit(db, `rl:like:ip:${ip}`, {
    max: 25,
    windowSec: 60,
  });
  if (ipHit.limited) {
    return {
      ok: false,
      error: "rate-limited",
      status: 429,
      retryAfter: ipHit.retryAfterSec,
    };
  }
  const actorHit = await hitReadLimit(db, `rl:like:actor:${actorId}`, {
    max: 12,
    windowSec: 60,
  });
  if (actorHit.limited) {
    return {
      ok: false,
      error: "rate-limited",
      status: 429,
      retryAfter: actorHit.retryAfterSec,
    };
  }
  return null;
}

/**
 * Toggle one like.
 * Same user id can never like that same profile id (admins included).
 */
export async function toggleLike(targetId, actorId, request = null) {
  const actor = parseUserId(actorId);
  const target = parseUserId(targetId);
  if (actor === null || target === null) {
    return { ok: false, reason: "bad-id", error: "bad-id", status: 400 };
  }

  // Hard block: actorId === targetId (covers admins / spoofed self-likes).
  if (actor === target) {
    const db = await getRedis();
    await stripSelfLike(db, target);
    const status = await getLikeStatus(target, actor);
    return {
      ok: false,
      reason: "self",
      error: "self",
      status: 400,
      ...status,
    };
  }

  if (request) {
    const limited = await guardLikeWrite(request, actor);
    if (limited) return limited;
  }

  const db = await getRedis();
  const k = key(target);
  await stripSelfLike(db, target);
  const member = String(actor);

  const already = Boolean(await db.sIsMember(k, member));
  if (already) {
    await db.sRem(k, member);
  } else {
    await db.sAdd(k, member);
  }

  // Drop leftover bonus key if present (one-shot cleanup on write)
  await db.del(bonusKey(target));

  const status = await getLikeStatus(target, actor);
  return { ok: true, ...status };
}
