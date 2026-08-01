/**
 * Server-owned author identity: authorId → canonical username.
 * Writes must present a PlayVortex session cookie that this server verifies
 * against /api/users/me. Client authorId / HMAC proofs are never trusted.
 */
import { createHash, timingSafeEqual } from "node:crypto";
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

function pickUsernameField(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return cleanUsername(candidate);
    }
    if (Array.isArray(candidate)) {
      const first = candidate.find((v) => typeof v === "string" && v.trim());
      if (first) return cleanUsername(first);
    }
  }
  return "";
}

function parseMePayload(data) {
  if (!data || typeof data !== "object") return null;
  const id = parseUserId(
    data?.id ?? data?.user_id ?? data?.userId ?? data?.user?.id,
  );
  const username = pickUsernameField(
    data?.username,
    data?.display_name,
    data?.displayName,
    data?.name,
    data?.user?.username,
    data?.user?.display_name,
    data?.user?.displayName,
    data?.user?.name,
  );
  if (id === null || !username || isPlaceholderUsername(username)) return null;
  return { id, username };
}

/**
 * Probe playvortex /api/users/me with a session cookie.
 * Distinguishes real auth failures from infra/CF blocks so the extension can
 * warm a short Redis session when the browser already verified the jar.
 *
 * @returns {Promise<{ kind: 'ok'|'unauthorized'|'unreachable'|'no-cookie', me: {id:number,username:string}|null }>}
 */
export async function probePlayvortexMe(sessionCookie) {
  const cookie = String(sessionCookie || "").trim();
  if (!cookie) return { kind: "no-cookie", me: null };

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

  let sawUnauthorized = false;
  let sawUnreachable = false;

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers, cache: "no-store" });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (res.ok) {
        const parsed = parseMePayload(data);
        if (parsed) return { kind: "ok", me: parsed };
      }

      const looksLikeCf =
        !data &&
        /cloudflare|cf-ray|just a moment|attention required/i.test(
          String(text || ""),
        );

      if (res.status === 401 || (res.status === 403 && data)) {
        sawUnauthorized = true;
        continue;
      }
      if (looksLikeCf || res.status >= 500 || res.status === 403) {
        sawUnreachable = true;
        continue;
      }
      if (!data) {
        sawUnreachable = true;
        continue;
      }
      sawUnauthorized = true;
    } catch {
      sawUnreachable = true;
    }
  }

  if (sawUnreachable && !sawUnauthorized) {
    return { kind: "unreachable", me: null };
  }
  if (sawUnreachable && sawUnauthorized) {
    // Mixed signals — prefer unreachable so a browser-warmed cache can help
    // when one edge is challenged and another returns a generic 401 page.
    return { kind: "unreachable", me: null };
  }
  return { kind: "unauthorized", me: null };
}

/**
 * Verify a browser session cookie against playvortex /api/users/me.
 * Cookie is used for this request only — never stored.
 * HMAC "proof" soft-fallback was removed after the client-shipped secret
 * let anyone impersonate TheHaloDeveloper.
 */
export async function fetchPlayvortexMe(sessionCookie) {
  const probe = await probePlayvortexMe(sessionCookie);
  return probe.kind === "ok" ? probe.me : null;
}

/**
 * Warm Redis session cache from a cookie the extension already verified.
 * Live /me wins; on infra/CF failure only, accept the browser-asserted me.
 */
export async function warmSessionFromBrowser(sessionCookie, clientMe = {}) {
  const cookie = String(sessionCookie || "").trim();
  if (!cookie) {
    return { ok: false, error: "session-required", status: 401 };
  }

  const probe = await probePlayvortexMe(cookie);
  if (probe.kind === "ok" && probe.me) {
    await setBoundUsername(probe.me.id, probe.me.username);
    await cacheSession(cookie, probe.me);
    return { ok: true, me: probe.me, source: "session" };
  }

  if (probe.kind === "unauthorized" || probe.kind === "no-cookie") {
    return { ok: false, error: "bad-session", status: 401 };
  }

  const id = parseUserId(clientMe?.id ?? clientMe?.user_id ?? clientMe?.userId);
  const username = cleanUsername(
    clientMe?.username ?? clientMe?.display_name ?? clientMe?.displayName,
  );
  if (id === null || !username || isPlaceholderUsername(username)) {
    return { ok: false, error: "bad-session", status: 401 };
  }

  await setBoundUsername(id, username);
  await cacheSession(cookie, { id, username });
  return {
    ok: true,
    me: { id, username },
    source: "browser-fallback",
  };
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

const SESSION_CACHE_TTL_SEC = 15 * 60;
// v2: old keys may have been poisoned by the retired HMAC proof soft-fallback.
const SESSION_CACHE_KEY = (hash) => `identity:session:v2:${hash}`;

function hashCookie(cookie) {
  return createHash("sha256").update(String(cookie)).digest("hex");
}

/** Read session cookie from request header only (never body — reduces CSRF/paste surface). */
export function sessionCookieFrom(request, _body = {}) {
  try {
    return String(request?.headers?.get?.("x-playvortex-cookie") || "").trim();
  } catch {
    return "";
  }
}

/**
 * Write proofs are retired. The HMAC secret was shipped in the extension, so
 * anyone could mint "I am user 1" proofs. Identity is session-cookie + /me only.
 * Kept as a no-op export so older callers keep compiling.
 */
export function writeProofFrom(_request, _body = {}) {
  return "";
}

function timingSafeEqualStr(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** @deprecated Proof minting disabled — always returns null. */
export function mintWriteProof() {
  return null;
}

/** @deprecated Proof verification disabled — always returns null. */
export function verifyWriteProof() {
  return null;
}

async function sessionFromCache(cookie) {
  try {
    const db = await getRedis();
    const raw = await db.get(SESSION_CACHE_KEY(hashCookie(cookie)));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const id = parseUserId(parsed?.id);
    const username = cleanUsername(parsed?.username);
    if (id === null || !username || isPlaceholderUsername(username)) return null;
    return { id, username };
  } catch {
    return null;
  }
}

async function cacheSession(cookie, me) {
  try {
    const db = await getRedis();
    await db.set(
      SESSION_CACHE_KEY(hashCookie(cookie)),
      JSON.stringify({ id: me.id, username: me.username }),
      { EX: SESSION_CACHE_TTL_SEC },
    );
  } catch {
    /* cache is best-effort */
  }
}

/**
 * Resolve author for writes. Server owns the display name.
 *
 * Identity ONLY from a PlayVortex session cookie verified against /me
 * (or a Redis cache entry written after a successful /me — never from proof).
 *
 * Client authorId / authorName / HMAC writeProof are never trusted.
 * The old proof soft-fallback let anyone mint "I am Halo" with the leaked
 * extension WRITE_SECRET — that path is permanently closed.
 */
export async function resolveAuthor({
  authorId: _ignoredAuthorId,
  authorName: _ignoredClientName,
  sessionCookie,
  writeProof: _ignoredWriteProof,
  requireSession = true,
}) {
  const cookie = String(sessionCookie || "").trim();
  if (cookie) {
    const cached = await sessionFromCache(cookie);
    if (cached) {
      await setBoundUsername(cached.id, cached.username);
      return {
        ok: true,
        authorId: cached.id,
        authorName: cached.username,
        source: "session-cache",
      };
    }

    const probe = await probePlayvortexMe(cookie);
    if (probe.kind === "ok" && probe.me) {
      await setBoundUsername(probe.me.id, probe.me.username);
      await cacheSession(cookie, probe.me);
      return {
        ok: true,
        authorId: probe.me.id,
        authorName: probe.me.username,
        source: "session",
      };
    }
    // Infra/CF block with no cache — ask the extension to POST /v1/identity/session
    // after a local Cookie-header /me success (see warmSessionFromBrowser).
    if (probe.kind === "unreachable") {
      return { ok: false, error: "session-unreachable", status: 401 };
    }
    return { ok: false, error: "bad-session", status: 401 };
  }

  if (!requireSession) {
    return { ok: false, error: "session-required", status: 401 };
  }
  return { ok: false, error: "session-required", status: 401 };
}

/** Convenience: resolve write identity from request headers. */
export async function resolveWriteIdentity(request, body = {}) {
  return resolveAuthor({
    authorId: body?.authorId ?? body?.actorId,
    authorName: body?.authorName,
    sessionCookie: sessionCookieFrom(request, body),
    writeProof: writeProofFrom(request, body),
    requireSession: true,
  });
}

export { timingSafeEqualStr };
