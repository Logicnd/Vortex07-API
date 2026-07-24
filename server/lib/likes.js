import { createClient } from "redis";

/** @type {import('redis').RedisClientType | null} */
let client = null;

async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL missing");
  }

  if (!client) {
    client = createClient({ url });
    client.on("error", (err) => console.error("redis error", err));
    await client.connect();
  } else if (!client.isOpen) {
    await client.connect();
  }

  return client;
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
  const db = await getRedis();
  const k = key(targetId);
  const count = Number(await db.sCard(k)) || 0;
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

export async function toggleLike(targetId, actorId) {
  if (actorId === targetId) {
    return { ok: false, reason: "self", status: 400 };
  }

  const db = await getRedis();
  const k = key(targetId);
  const member = String(actorId);
  const already = Boolean(await db.sIsMember(k, member));

  if (already) {
    await db.sRem(k, member);
  } else {
    await db.sAdd(k, member);
  }

  const status = await getLikeStatus(targetId, actorId);
  return { ok: true, ...status };
}
