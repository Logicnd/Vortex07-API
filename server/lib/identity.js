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
  return (
    !n ||
    n === "profile" ||
    n === "my vortex" ||
    n === "my profile" ||
    n === "guest" ||
    n === "not me" ||
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
 */
export async function canonicalUsername(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return null;
  const live = await fetchPlayvortexUsername(uid);
  if (live) {
    await setBoundUsername(uid, live);
    return live;
  }
  const bound = await getBoundUsername(uid);
  if (bound) return bound;
  const known = KNOWN_IDENTITIES[uid];
  if (known) {
    await setBoundUsername(uid, known);
    return known;
  }
  return null;
}

/**
 * Resolve author for writes. Server owns the display name.
 *
 * Preferred: sessionCookie → playvortex /me (authorId cannot be forged).
 * Fallback (legacy clients): live/bound/known name only — never trust client claim.
 */
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

export async function resolveAuthor({
  authorId,
  authorName,
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
    // Cookie present but playvortex rejected it (common from Vercel IPs).
    // Fall through to name-lock instead of hard-failing real users.
    if (requireSession) {
      return { ok: false, error: "bad-session", status: 401 };
    }
  } else if (requireSession) {
    return { ok: false, error: "session-required", status: 401 };
  }

  // Name lock: live / bound / known win. Client authorName is never trusted
  // once an id is known. High ids may bind once to a free non-placeholder name.
  const uid = parseUserId(authorId);
  if (uid === null) {
    return { ok: false, error: "bad-actor", status: 400 };
  }

  // Low platform ids (1..999) cannot be used without a verified browser session.
  // Otherwise anyone can post as TheHaloDeveloper via known/bound names.
  if (uid < 1000) {
    return { ok: false, error: "identity-unverified", status: 403 };
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

  const claimed = cleanUsername(authorName);
  const db = await getRedis();

  if (claimed && !isPlaceholderUsername(claimed)) {
    const owner = parseUserId(await db.get(NAME_KEY(claimed)));
    const reserved = Object.values(KNOWN_IDENTITIES).some((n) =>
      namesMatch(n, claimed),
    );
    if ((owner === null || owner === uid) && !reserved) {
      await setBoundUsername(uid, claimed);
      return {
        ok: true,
        authorId: uid,
        authorName: claimed,
        source: "claim",
      };
    }
  }

  const fallback = `Player ${uid}`;
  await setBoundUsername(uid, fallback);
  return {
    ok: true,
    authorId: uid,
    authorName: fallback,
    source: "fallback",
  };
}
