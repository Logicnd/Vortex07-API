/**
 * Server-owned author identity: authorId → canonical username.
 * Clients cannot override a bound/live name — any extension version is ignored.
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
    /^(.)\1{7,}$/i.test(n)
  );
}

export function namesMatch(a, b) {
  return cleanUsername(a).toLowerCase() === cleanUsername(b).toLowerCase();
}

export async function fetchPlayvortexUsername(userId) {
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
 * Canonical username for an id (live → bound → null).
 * Used by repair jobs and writes.
 */
export async function canonicalUsername(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return null;
  const live = await fetchPlayvortexUsername(uid);
  if (live) {
    await setBoundUsername(uid, live);
    return live;
  }
  return getBoundUsername(uid);
}

/**
 * Resolve author for writes. Server owns the display name.
 * - Live / bound name always wins (client authorName is ignored)
 * - Unbound: first valid non-placeholder claim binds; else Player {id}
 * Old extension versions cannot override a bound name.
 */
export async function resolveAuthor({ authorId, authorName }) {
  const uid = parseUserId(authorId);
  if (uid === null) {
    return { ok: false, error: "bad-actor", status: 400 };
  }

  const live = await fetchPlayvortexUsername(uid);
  if (live) {
    await setBoundUsername(uid, live);
    return { ok: true, authorId: uid, authorName: live, source: "live" };
  }

  const bound = await getBoundUsername(uid);
  if (bound) {
    // Bound name is authoritative — ignore whatever the client sent.
    return { ok: true, authorId: uid, authorName: bound, source: "bound" };
  }

  const claimed = cleanUsername(authorName);
  const name =
    claimed && !isPlaceholderUsername(claimed) ? claimed : `Player ${uid}`;

  const db = await getRedis();
  if (!isPlaceholderUsername(name)) {
    const ownerRaw = await db.get(NAME_KEY(name));
    const owner = parseUserId(ownerRaw);
    if (owner !== null && owner !== uid) {
      // Name already owned by someone else — keep this id on Player {id}
      const fallback = `Player ${uid}`;
      await setBoundUsername(uid, fallback);
      return {
        ok: true,
        authorId: uid,
        authorName: fallback,
        source: "fallback",
      };
    }
  }

  await setBoundUsername(uid, name);
  return {
    ok: true,
    authorId: uid,
    authorName: name,
    source: isPlaceholderUsername(claimed) ? "fallback" : "claim",
  };
}
