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

function upKey(targetId) {
  return `ratings:${targetId}:up`;
}

function downKey(targetId) {
  return `ratings:${targetId}:down`;
}

export function parseTargetId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function parseActorId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function parseVote(value) {
  if (value === "up" || value === "like" || value === 1 || value === "1") {
    return "up";
  }
  if (value === "down" || value === "dislike" || value === -1 || value === "-1") {
    return "down";
  }
  if (value === null || value === "null" || value === "" || value === "clear") {
    return null;
  }
  return undefined;
}

export async function getRatingStatus(targetId, actorId) {
  const db = await getRedis();
  const up = upKey(targetId);
  const down = downKey(targetId);

  const [likes, dislikes] = await Promise.all([
    db.sCard(up).then((n) => Number(n) || 0),
    db.sCard(down).then((n) => Number(n) || 0),
  ]);

  let myVote = null;
  if (actorId !== null) {
    const member = String(actorId);
    const [isUp, isDown] = await Promise.all([
      db.sIsMember(up, member),
      db.sIsMember(down, member),
    ]);
    if (isUp) myVote = "up";
    else if (isDown) myVote = "down";
  }

  return {
    targetId,
    likes,
    dislikes,
    myVote,
  };
}

/**
 * Set or toggle a like/dislike.
 * - Same vote again → clear
 * - Opposite vote → switch
 * - vote null → clear
 */
export async function setRating(targetId, actorId, vote) {
  if (vote === undefined) {
    return { ok: false, reason: "bad-vote", status: 400 };
  }

  const db = await getRedis();
  const up = upKey(targetId);
  const down = downKey(targetId);
  const member = String(actorId);

  const [isUp, isDown] = await Promise.all([
    db.sIsMember(up, member),
    db.sIsMember(down, member),
  ]);

  const current = isUp ? "up" : isDown ? "down" : null;
  let next = vote;

  // Toggle off when clicking the same side again
  if (vote !== null && vote === current) {
    next = null;
  }

  const ops = [];
  if (next === "up") {
    ops.push(db.sAdd(up, member), db.sRem(down, member));
  } else if (next === "down") {
    ops.push(db.sAdd(down, member), db.sRem(up, member));
  } else {
    ops.push(db.sRem(up, member), db.sRem(down, member));
  }
  await Promise.all(ops);

  const status = await getRatingStatus(targetId, actorId);
  return { ok: true, ...status };
}
