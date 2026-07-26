/**
 * Bind playvortex user id → canonical username.
 * Prevents forum/DM/comment spoofing where clients invent authorId/authorName.
 */
import { getRedis } from "./redis.js";

const BIND_KEY = (id) => `identity:user:${id}`;
const NAME_KEY = (name) => `identity:name:${String(name).toLowerCase()}`;
const PLAYVORTEX_USER = (id) => `https://playvortex.io/api/users/${id}`;
const LOOKUP_TTL_MS = 10 * 60 * 1000;

/** @type {Map<number, { at: number, username: string|null }>} */
const lookupMem = new Map();

export function parseUserId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function cleanUsername(value, max = 40) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function isPlaceholderUsername(name) {
  const n = cleanUsername(name).toLowerCase();
  return (
    !n ||
    n === "profile" ||
    n === "my vortex" ||
    n === "my profile" ||
    n === "guest" ||
    /^player\s+\d+$/i.test(n) ||
    /^(.)\1{7,}$/i.test(n) // aaaaaaaa / !!!!!!!!
  );
}

export function namesMatch(a, b) {
  return cleanUsername(a).toLowerCase() === cleanUsername(b).toLowerCase();
}

async function fetchPlayvortexUsername(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return null;

  const cached = lookupMem.get(uid);
  if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) {
    return cached.username;
  }

  const headers = {
    Accept: "application/json",
    "User-Agent": "Vortex07-API/identity",
  };
  const cookie = String(process.env.PLAYVORTEX_COOKIE || "").trim();
  if (cookie) headers.Cookie = cookie;

  try {
    const res = await fetch(PLAYVORTEX_USER(uid), {
      headers,
      cache: "no-store",
    });
    if (!res.ok) {
      lookupMem.set(uid, { at: Date.now(), username: null });
      return null;
    }
    const data = await res.json();
    const username = cleanUsername(
      data?.username || data?.display_name || data?.displayName || data?.name,
    );
    const out = username || null;
    lookupMem.set(uid, { at: Date.now(), username: out });
    return out;
  } catch {
    lookupMem.set(uid, { at: Date.now(), username: null });
    return null;
  }
}

export async function getBoundUsername(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return null;
  const db = await getRedis();
  const name = cleanUsername(await db.get(BIND_KEY(uid)));
  return name || null;
}

export async function setBoundUsername(userId, username) {
  const uid = parseUserId(userId);
  const name = cleanUsername(username);
  if (uid === null || !name) return false;
  const db = await getRedis();
  const prev = cleanUsername(await db.get(BIND_KEY(uid)));
  if (prev && !namesMatch(prev, name)) {
    await db.del(NAME_KEY(prev));
  }
  await db.set(BIND_KEY(uid), name);
  await db.set(NAME_KEY(name), String(uid));
  return true;
}

export async function clearBoundUsername(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return false;
  const db = await getRedis();
  const prev = cleanUsername(await db.get(BIND_KEY(uid)));
  await db.del(BIND_KEY(uid));
  if (prev) await db.del(NAME_KEY(prev));
  return true;
}

/**
 * Resolve a trusted author identity for writes.
 * - Live playvortex username wins when available
 * - Else existing Redis binding must match claimed name
 * - Else first claim binds the cleaned name (high ids only; low ids need live)
 * Claimed name is required — placeholders are always rejected.
 */
export async function resolveAuthor({ authorId, authorName }) {
  const uid = parseUserId(authorId);
  if (uid === null) {
    return { ok: false, error: "bad-actor", status: 400 };
  }

  const claimed = cleanUsername(authorName);
  if (!claimed || isPlaceholderUsername(claimed)) {
    return { ok: false, error: "bad-author-name", status: 400 };
  }

  const live = await fetchPlayvortexUsername(uid);

  if (live) {
    await setBoundUsername(uid, live);
    if (!namesMatch(claimed, live)) {
      return {
        ok: false,
        error: "name-mismatch",
        status: 403,
        expected: live,
        authorId: uid,
      };
    }
    return { ok: true, authorId: uid, authorName: live, source: "live" };
  }

  const bound = await getBoundUsername(uid);
  if (bound) {
    if (!namesMatch(claimed, bound)) {
      return {
        ok: false,
        error: "name-mismatch",
        status: 403,
        expected: bound,
        authorId: uid,
      };
    }
    return { ok: true, authorId: uid, authorName: bound, source: "bound" };
  }

  // Low ids are easy spoof targets without live verification.
  if (uid < 1000) {
    return {
      ok: false,
      error: "identity-unverified",
      status: 403,
      authorId: uid,
    };
  }

  // Name already bound to a different id?
  const db = await getRedis();
  const ownerRaw = await db.get(NAME_KEY(claimed));
  const owner = parseUserId(ownerRaw);
  if (owner !== null && owner !== uid) {
    return {
      ok: false,
      error: "name-taken",
      status: 403,
      ownerId: owner,
    };
  }

  await setBoundUsername(uid, claimed);
  return { ok: true, authorId: uid, authorName: claimed, source: "claim" };
}
