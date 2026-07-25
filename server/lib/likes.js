import { getRedis } from "./redis.js";

function key(targetId) {
  return `likes:${targetId}`;
}

function bonusKey(targetId) {
  return `likes:bonus:${targetId}`;
}

export function parseUserId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/** Legacy stacked-like bonuses (no longer written). Still counted in totals. */
async function bonusCount(db, targetId) {
  const raw = await db.get(bonusKey(targetId));
  return Math.max(0, Number(raw) || 0);
}

export async function getLikeStatus(targetId, actorId) {
  const db = await getRedis();
  const k = key(targetId);
  const base = Number(await db.sCard(k)) || 0;
  const bonus = await bonusCount(db, targetId);
  const count = base + bonus;
  let liked = false;
  if (actorId !== null) {
    liked = Boolean(await db.sIsMember(k, String(actorId)));
  }
  return {
    targetId,
    count,
    liked,
    myVote: liked ? "up" : null,
  };
}

/** Toggle one like. Cannot like own profile. */
export async function toggleLike(targetId, actorId) {
  const actor = parseUserId(actorId);
  const target = parseUserId(targetId);
  if (actor === null || target === null) {
    return { ok: false, reason: "bad-id", status: 400 };
  }

  if (actor === target) {
    return { ok: false, reason: "self", status: 400 };
  }

  const db = await getRedis();
  const k = key(target);
  const member = String(actor);

  const already = Boolean(await db.sIsMember(k, member));
  if (already) {
    await db.sRem(k, member);
  } else {
    await db.sAdd(k, member);
  }

  const status = await getLikeStatus(target, actor);
  return { ok: true, ...status };
}
