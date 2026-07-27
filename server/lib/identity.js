/**
 * Server-owned author identity: authorId → canonical username.
 * Writes should pass a playvortex session cookie so authorId cannot be forged.
 */
import { getRedis } from "./redis.js";

const BIND_KEY = (id) => `identity:user:${id}`;
const NAME_KEY = (name) => `identity:name:${String(name).toLowerCase()}`;
const PLAYVORTEX_USER = (id) => `https://playvortex.io/api/users/${id}`;
const PLAYVORTEX_ME = "https://playvortex.io/api/users/me";
const LOOKUP_TTL_MS = 10 * 60 * 1000;

/** Seed binds for well-known accounts (used when live lookup is unavailable). */
export const KNOWN_IDENTITIES = {
  1: "TheHaloDeveloper",
  15936: "Kiri",
  18202: "Kio",
  22795: "erik2",
  61874: "pzz",
  16744: "HotdogBBQ3",
  21848: "tacohacker",
  37719: "valley",
  40181: "USMark",
  24351: "DeltaX",
  29289: "sujion",
  34712: "endstuff",
  4426: "LSPLASKI",
  54234: "D4NE",
};

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
  if (
    !n ||
    n === "profile" ||
    n === "my vortex" ||
    n === "my profile" ||
    n === "guest" ||
    n === "not me" ||
    n === "you" ||
    n === "user" ||
    n === "player" ||
    /^player\s+\d+$/i.test(n) ||
    /^(.)\1{7,}$/i.test(n)
  ) {
    return true;
  }
  // Block JS / language junk that shows up from client bugs or spoof attempts
  if (
    /^(array|object|undefined|null|nan|true|false|function|string|number|boolean|symbol|bigint)$/i.test(
      n,
    )
  ) {
    return true;
  }
  return false;
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
    const out =
      username && !isPlaceholderUsername(username) ? username : null;
    lookupMem.set(uid, { at: Date.now(), username: out });
    return out;
  } catch {
    lookupMem.set(uid, { at: Date.now(), username: null });
    return null;
  }
}

/**
 * Verify a browser session cookie against playvortex /api/users/me.
 * Cookie is used for this request only — never stored.
 * Note: playvortex/CF often rejects datacenter IPs, so callers must soft-fallback.
 */
export async function fetchPlayvortexMe(sessionCookie) {
  const cookie = String(sessionCookie || "").trim();
  if (!cookie) return null;

  const endpoints = [
    PLAYVORTEX_ME,
    "https://www.playvortex.io/api/users/me",
  ];
  const headers = {
    Accept: "application/json",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    Cookie: cookie,
    Origin: "https://playvortex.io",
    Referer: "https://playvortex.io/",
  };

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers, cache: "no-store" });
      if (!res.ok) continue;
      const data = await res.json();
      const id = parseUserId(data?.id ?? data?.user_id ?? data?.userId);
      const username = cleanUsername(
        data?.username || data?.display_name || data?.displayName || data?.name,
      );
      if (id === null || !username || isPlaceholderUsername(username)) continue;
      return { id, username };
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function getBoundUsername(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return null;
  const db = await getRedis();
  const name = cleanUsername(await db.get(BIND_KEY(uid)));
  if (!name) return null;
  // Drop spoofed / junk binds so they cannot keep shipping to clients
  if (isPlaceholderUsername(name)) {
    await db.del(BIND_KEY(uid));
    await db.del(NAME_KEY(name));
    return null;
  }
  return name;
}

export async function setBoundUsername(userId, username) {
  const uid = parseUserId(userId);
  const name = cleanUsername(username);
  if (uid === null || !name || isPlaceholderUsername(name)) return false;
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

/** Ensure seed binds exist (does not overwrite a different live-quality bind). */
export async function ensureKnownIdentities() {
  let seeded = 0;
  for (const [id, name] of Object.entries(KNOWN_IDENTITIES)) {
    const uid = Number(id);
    const existing = await getBoundUsername(uid);
    if (!existing || isPlaceholderUsername(existing) || existing === "not me") {
      await setBoundUsername(uid, name);
      seeded += 1;
    }
  }
  return seeded;
}

/**
 * Canonical username for an id (live → bound → known → null).
 * Never returns placeholder/junk names.
 */
export async function canonicalUsername(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return null;
  const live = await fetchPlayvortexUsername(uid);
  if (live && !isPlaceholderUsername(live)) {
    await setBoundUsername(uid, live);
    return live;
  }
  const bound = await getBoundUsername(uid);
  if (bound && !isPlaceholderUsername(bound)) return bound;
  const known = KNOWN_IDENTITIES[uid];
  if (known && !isPlaceholderUsername(known)) {
    await setBoundUsername(uid, known);
    return known;
  }
  return null;
}

/**
 * Sweep Redis identity binds and delete junk/spoof placeholders
 * (e.g. "Array", "Guest", "not me").
 */
export async function scrubJunkIdentityBinds() {
  const db = await getRedis();
  let scanned = 0;
  let removed = 0;
  let cursor = 0;
  do {
    const res = await db.scan(cursor, {
      MATCH: "identity:user:*",
      COUNT: 200,
    });
    cursor = Number(res.cursor ?? 0);
    const keys = res.keys ?? [];
    for (const key of keys) {
      scanned += 1;
      const name = cleanUsername(await db.get(key));
      if (!name || isPlaceholderUsername(name)) {
        const uid = parseUserId(String(key).split(":").pop());
        if (uid !== null) await clearBoundUsername(uid);
        else {
          await db.del(key);
          if (name) await db.del(NAME_KEY(name));
        }
        removed += 1;
      }
    }
  } while (cursor !== 0);
  return { ok: true, scanned, removed };
}

/** Read session cookie from JSON body and/or request header (never logged). */
export function sessionCookieFrom(request, body = {}) {
  const fromBody = String(body?.sessionCookie || "").trim();
  if (fromBody) return fromBody;
  try {
    return String(request?.headers?.get?.("x-playvortex-cookie") || "").trim();
  } catch {
    return "";
  }
}

/**
 * Resolve author for writes. Server owns the display name.
 *
 * Session cookie verify is best-effort only — playvortex often rejects
 * Vercel datacenter IPs (bad-session). Real clients should stamp authorId
 * from a same-origin /me fetch in the extension background.
 *
 * Name lock: live → bound → known → Player {id} fallback.
 * Client-supplied authorName is never first-claimed (spoof vector).
 * Owner id 1 (TheHaloDeveloper) is allowed via known bind.
 */
export async function resolveAuthor({
  authorId,
  authorName: _ignoredClientName,
  sessionCookie,
  requireSession = false,
}) {
  const cookie = String(sessionCookie || "").trim();
  if (cookie) {
    const me = await fetchPlayvortexMe(cookie);
    if (me) {
      await setBoundUsername(me.id, me.username);
      return {
        ok: true,
        authorId: me.id,
        authorName: me.username,
        source: "session",
      };
    }
    // Never hard-fail here — CF/Vercel IP blocks are common.
    if (requireSession) {
      return { ok: false, error: "bad-session", status: 401 };
    }
  } else if (requireSession) {
    return { ok: false, error: "session-required", status: 401 };
  }

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
  if (bound && !isPlaceholderUsername(bound)) {
    return { ok: true, authorId: uid, authorName: bound, source: "bound" };
  }

  const known = KNOWN_IDENTITIES[uid];
  if (known) {
    await setBoundUsername(uid, known);
    return { ok: true, authorId: uid, authorName: known, source: "known" };
  }

  // Low ids with no known/bound/live identity: reject (stops 1..99 flood claims).
  // Id 1 is seeded as TheHaloDeveloper above via KNOWN_IDENTITIES.
  if (uid < 1000) {
    return { ok: false, error: "identity-unverified", status: 403 };
  }

  // First-claim of unverified usernames is a spoof vector — do not honor
  // client-supplied authorName when live/bound/known identity is missing.
  const fallback = `Player ${uid}`;
  await setBoundUsername(uid, fallback);
  return {
    ok: true,
    authorId: uid,
    authorName: fallback,
    source: "fallback",
  };
}
