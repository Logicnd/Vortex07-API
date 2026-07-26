import { getRedis } from "./redis.js";
import { resolveAuthor } from "./identity.js";

export const COMMENT_BODY_MAX = 1000;
export const COMMENT_LIST_MAX = 100;

/** Same mods as forum — can delete any place comment. */
export const COMMENT_MOD_IDS = new Set([1, 15936, 18202, 22795]);

function listKey(gameId) {
  return `comments:${gameId}`;
}

export function parseGameId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function parseActorId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function canModerateComments(actorId) {
  const uid = parseActorId(actorId);
  return uid !== null && COMMENT_MOD_IDS.has(uid);
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

async function nextId(db) {
  return Number(await db.incr("comments:meta:next:id"));
}

export async function listComments(gameId, limit = 50, offset = 0) {
  const db = await getRedis();
  const start = Math.max(0, Number(offset) || 0);
  const stop =
    start + Math.min(COMMENT_LIST_MAX, Math.max(1, Number(limit) || 50)) - 1;
  const rows = await db.lRange(listKey(gameId), start, stop);
  const comments = [];
  for (const row of rows) {
    try {
      comments.push(JSON.parse(row));
    } catch {
      /* skip */
    }
  }
  const total = Number(await db.lLen(listKey(gameId))) || 0;
  return { gameId, comments, total };
}

export async function addComment({
  gameId,
  body,
  authorId,
  authorName,
  sessionCookie,
}) {
  const db = await getRedis();
  const cleanBody = cleanText(body, COMMENT_BODY_MAX);
  if (!cleanBody) {
    return { ok: false, error: "bad-body", status: 400 };
  }

  const identity = await resolveAuthor({
    authorId,
    authorName,
    sessionCookie,
    requireSession: true,
  });
  if (!identity.ok) return identity;

  const now = new Date().toISOString();
  const comment = {
    id: String(await nextId(db)),
    gameId,
    authorId: identity.authorId,
    authorName: identity.authorName,
    body: cleanBody,
    createdAt: now,
  };

  const key = listKey(gameId);
  await db.lPush(key, JSON.stringify(comment));
  // Cap stored comments per place
  await db.lTrim(key, 0, COMMENT_LIST_MAX - 1);

  return { ok: true, comment };
}

export async function deleteComment({ gameId, commentId, actorId }) {
  const db = await getRedis();
  const uid = parseActorId(actorId);
  if (uid === null) {
    return { ok: false, error: "bad-actor", status: 400 };
  }

  const id = String(commentId || "");
  if (!id) {
    return { ok: false, error: "bad-id", status: 400 };
  }

  const key = listKey(gameId);
  const rows = await db.lRange(key, 0, -1);
  let targetRaw = null;
  let target = null;

  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row);
    } catch {
      continue;
    }
    if (String(parsed?.id) === id) {
      targetRaw = row;
      target = parsed;
      break;
    }
  }

  if (!target || !targetRaw) {
    return { ok: false, error: "not-found", status: 404 };
  }

  const isAuthor = Number(target.authorId) === uid;
  if (!isAuthor && !canModerateComments(uid)) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  await db.lRem(key, 1, targetRaw);
  return { ok: true, deletedId: id };
}
