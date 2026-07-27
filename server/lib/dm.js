import { getRedis } from "./redis.js";
import { FORUM_MOD_IDS, canModerateForum } from "./forum.js";
import {
  resolveAuthor,
  cleanUsername,
  isPlaceholderUsername,
  canonicalUsername,
} from "./identity.js";

export const DM_BODY_MAX = 1000;
export const DM_MODLOG_MAX = 200;
export const DM_RATE_MS = 1000;
export const GC_NAME_MAX = 60;
export const GC_MEMBERS_MIN = 3;
export const GC_MEMBERS_MAX = 20;

export { FORUM_MOD_IDS, canModerateForum };

function parseUserId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

function threadIdFor(a, b) {
  const x = Math.min(a, b);
  const y = Math.max(a, b);
  return `${x}:${y}`;
}

function threadKey(tid) {
  return `dm:thread:${tid}`;
}

function msgsKey(tid) {
  return `dm:thread:${tid}:msgs`;
}

function userThreadsKey(uid) {
  return `dm:user:${uid}:threads`;
}

function unreadKey(uid) {
  return `dm:unread:${uid}`;
}

function mutedKey() {
  return "dm:muted";
}

function modlogKey() {
  return "dm:modlog";
}

function rateKey(uid) {
  return `dm:rate:${uid}`;
}

function gcKey(gid) {
  return `dm:gc:${gid}`;
}

function gcMsgsKey(gid) {
  return `dm:gc:${gid}:msgs`;
}

function gcInboxValue(gid) {
  return `gc:${gid}`;
}

function parseGroupId(value) {
  const raw = String(value ?? "").trim();
  const id = raw.startsWith("gc:") ? raw.slice(3) : raw;
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  return String(n);
}

async function nextMsgId(db) {
  return Number(await db.incr("dm:meta:next:msg"));
}

async function nextGroupId(db) {
  return String(await db.incr("dm:meta:next:gc"));
}

/** Server-owned display name for a user id (never trust client peerName). */
async function displayNameFor(userId, fallback) {
  const uid = parseUserId(userId);
  if (uid === null) return cleanUsername(fallback) || "Guest";
  const live = await canonicalUsername(uid);
  if (live && !isPlaceholderUsername(live)) return live;
  const fb = cleanUsername(fallback);
  if (fb && !isPlaceholderUsername(fb)) return fb;
  return `Player ${uid}`;
}

export async function isMuted(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return false;
  const db = await getRedis();
  const raw = await db.hGet(mutedKey(), String(uid));
  return Boolean(raw);
}

export async function getMuteInfo(userId) {
  const uid = parseUserId(userId);
  if (uid === null) return null;
  const db = await getRedis();
  const raw = await db.hGet(mutedKey(), String(uid));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { reason: "muted", by: null, at: null };
  }
}

async function unreadTotal(db, uid) {
  const all = await db.hGetAll(unreadKey(uid));
  let total = 0;
  for (const v of Object.values(all || {})) {
    total += Math.max(0, Number(v) || 0);
  }
  return total;
}

export async function getUnreadCount(actorId) {
  const uid = parseUserId(actorId);
  if (uid === null) return { ok: false, error: "bad-actor", status: 400 };
  const db = await getRedis();
  const count = await unreadTotal(db, uid);
  const muted = await isMuted(uid);
  return { ok: true, count, muted };
}

export async function listInbox(actorId) {
  const uid = parseUserId(actorId);
  if (uid === null) return { ok: false, error: "bad-actor", status: 400 };

  const db = await getRedis();
  const ids = await db.zRange(userThreadsKey(uid), 0, 49, { REV: true });
  const unreadMap = (await db.hGetAll(unreadKey(uid))) || {};
  const conversations = [];

  for (const tid of ids) {
    if (String(tid).startsWith("gc:")) {
      const gid = parseGroupId(tid);
      if (!gid) continue;
      const raw = await db.get(gcKey(gid));
      if (!raw) continue;
      let meta;
      try {
        meta = JSON.parse(raw);
      } catch {
        continue;
      }
      const members = Array.isArray(meta.members)
        ? meta.members.map(Number).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      if (!members.includes(uid)) continue;
      const title = cleanText(meta.name, GC_NAME_MAX) || `Group ${gid}`;
      let lastPreview = meta.lastPreview || "";
      const lastRows = await db.lRange(gcMsgsKey(gid), -1, -1);
      if (lastRows?.[0]) {
        try {
          const lastMsg = JSON.parse(lastRows[0]);
          const from = parseUserId(lastMsg?.from);
          if (from !== null) {
            const who = await displayNameFor(from, lastMsg.authorName);
            const body = cleanText(lastMsg.body, 100);
            lastPreview = body ? `${who}: ${body}`.slice(0, 120) : who;
          }
        } catch {
          /* keep meta preview */
        }
      }
      conversations.push({
        kind: "gc",
        threadId: gcInboxValue(gid),
        groupId: gid,
        title,
        peerId: null,
        peerName: title,
        memberCount: members.length,
        lastPreview,
        updatedAt: meta.updatedAt || null,
        unread: Math.max(0, Number(unreadMap[gcInboxValue(gid)]) || 0),
      });
      continue;
    }

    const raw = await db.get(threadKey(tid));
    if (!raw) continue;
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    const peerId = Number(meta.a) === uid ? Number(meta.b) : Number(meta.a);
    const storedPeerName =
      Number(meta.a) === uid
        ? meta.bName || `Player ${peerId}`
        : meta.aName || `Player ${peerId}`;
    const peerName = await displayNameFor(peerId, storedPeerName);
    conversations.push({
      kind: "dm",
      threadId: tid,
      peerId,
      peerName,
      title: peerName,
      lastPreview: meta.lastPreview || "",
      updatedAt: meta.updatedAt || null,
      unread: Math.max(0, Number(unreadMap[tid]) || 0),
    });
  }

  return {
    ok: true,
    conversations,
    muted: await isMuted(uid),
  };
}

export async function getThread(actorId, peerId) {
  const uid = parseUserId(actorId);
  const peer = parseUserId(peerId);
  if (uid === null) return { ok: false, error: "bad-actor", status: 400 };
  if (peer === null || peer === uid) {
    return { ok: false, error: "bad-peer", status: 400 };
  }

  const db = await getRedis();
  const tid = threadIdFor(uid, peer);
  const raw = await db.get(threadKey(tid));
  let meta = null;
  if (raw) {
    try {
      meta = JSON.parse(raw);
    } catch {
      meta = null;
    }
  }

  const rows = await db.lRange(msgsKey(tid), 0, -1);
  const messages = [];
  for (const row of rows) {
    try {
      messages.push(JSON.parse(row));
    } catch {
      /* skip */
    }
  }

  // Mark read
  await db.hDel(unreadKey(uid), tid);

  const storedPeerName =
    meta && Number(meta.a) === uid
      ? meta.bName
      : meta && Number(meta.b) === uid
        ? meta.aName
        : `Player ${peer}`;

  const peerName = await displayNameFor(peer, storedPeerName);

  return {
    ok: true,
    threadId: tid,
    peerId: peer,
    peerName,
    messages,
    muted: await isMuted(uid),
    peerMuted: await isMuted(peer),
  };
}

export async function sendMessage({
  actorId,
  peerId,
  authorName,
  peerName: _clientPeerName,
  body,
  sessionCookie,
}) {
  const peer = parseUserId(peerId);
  if (peer === null) {
    return { ok: false, error: "bad-peer", status: 400 };
  }

  const cleanBody = cleanText(body, DM_BODY_MAX);
  if (!cleanBody) return { ok: false, error: "bad-body", status: 400 };

  const identity = await resolveAuthor({
    authorId: actorId,
    authorName,
    sessionCookie,
    requireSession: false,
  });
  if (!identity.ok) return identity;
  const uid = identity.authorId;
  const name = identity.authorName;
  if (peer === uid) {
    return { ok: false, error: "bad-peer", status: 400 };
  }

  if (await isMuted(uid)) {
    return { ok: false, error: "muted", status: 403 };
  }
  if (await isMuted(peer)) {
    return { ok: false, error: "peer-muted", status: 403 };
  }
  // Never trust client peerName — resolve peer label from id only.
  const peerLabel = await displayNameFor(peer, `Player ${peer}`);

  const db = await getRedis();

  // Simple rate limit
  const last = await db.get(rateKey(uid));
  if (last) {
    const elapsed = Date.now() - Number(last);
    if (elapsed >= 0 && elapsed < DM_RATE_MS) {
      return { ok: false, error: "rate-limited", status: 429 };
    }
  }

  // One conversation per unordered pair (min:max) — never duplicated.
  const tid = threadIdFor(uid, peer);
  const now = new Date().toISOString();

  let meta = null;
  const existing = await db.get(threadKey(tid));
  if (existing) {
    try {
      meta = JSON.parse(existing);
    } catch {
      meta = null;
    }
  }

  if (!meta) {
    meta = {
      id: tid,
      a: Math.min(uid, peer),
      b: Math.max(uid, peer),
      aName: uid < peer ? name : peerLabel,
      bName: uid < peer ? peerLabel : name,
      updatedAt: now,
      lastPreview: cleanBody.slice(0, 120),
    };
  }

  if (Number(meta.a) === uid) meta.aName = name;
  if (Number(meta.b) === uid) meta.bName = name;
  if (Number(meta.a) === peer) meta.aName = peerLabel;
  if (Number(meta.b) === peer) meta.bName = peerLabel;
  meta.updatedAt = now;
  meta.lastPreview = cleanBody.slice(0, 120);

  const msg = {
    id: String(await nextMsgId(db)),
    from: uid,
    body: cleanBody,
    createdAt: now,
  };

  await db.rPush(msgsKey(tid), JSON.stringify(msg));
  await db.set(threadKey(tid), JSON.stringify(meta));
  const score = Date.now();
  await db.zAdd(userThreadsKey(uid), { score, value: tid });
  await db.zAdd(userThreadsKey(peer), { score, value: tid });
  await db.hIncrBy(unreadKey(peer), tid, 1);
  await db.set(rateKey(uid), String(score), { PX: DM_RATE_MS });

  const logEntry = {
    id: msg.id,
    threadId: tid,
    from: uid,
    fromName: name,
    to: peer,
    body: cleanBody.slice(0, 200),
    createdAt: now,
  };
  await db.lPush(modlogKey(), JSON.stringify(logEntry));
  await db.lTrim(modlogKey(), 0, DM_MODLOG_MAX - 1);

  return { ok: true, threadId: tid, message: msg, meta };
}

export async function createGroupChat({
  actorId,
  name,
  memberIds,
  authorName,
  sessionCookie,
}) {
  const identity = await resolveAuthor({
    authorId: actorId,
    authorName,
    sessionCookie,
    requireSession: false,
  });
  if (!identity.ok) return identity;
  const uid = identity.authorId;

  if (await isMuted(uid)) {
    return { ok: false, error: "muted", status: 403 };
  }

  const groupName = cleanText(name, GC_NAME_MAX);
  if (!groupName) return { ok: false, error: "bad-name", status: 400 };

  const rawMembers = Array.isArray(memberIds) ? memberIds : [];
  const memberSet = new Set();
  memberSet.add(uid);
  for (const raw of rawMembers) {
    const id = parseUserId(raw);
    if (id !== null) memberSet.add(id);
  }
  const members = [...memberSet].sort((a, b) => a - b);
  if (members.length < GC_MEMBERS_MIN) {
    return { ok: false, error: "too-few-members", status: 400 };
  }
  if (members.length > GC_MEMBERS_MAX) {
    return { ok: false, error: "too-many-members", status: 400 };
  }

  const db = await getRedis();
  const gid = await nextGroupId(db);
  const now = new Date().toISOString();
  const meta = {
    id: gid,
    name: groupName,
    members,
    createdBy: uid,
    updatedAt: now,
    lastPreview: "",
  };

  await db.set(gcKey(gid), JSON.stringify(meta));
  const score = Date.now();
  const inboxVal = gcInboxValue(gid);
  for (const mid of members) {
    await db.zAdd(userThreadsKey(mid), { score, value: inboxVal });
  }

  return {
    ok: true,
    group: {
      kind: "gc",
      groupId: gid,
      name: groupName,
      members,
      createdBy: uid,
      updatedAt: now,
      lastPreview: "",
      memberCount: members.length,
    },
  };
}

export async function getGroupThread(actorId, groupId) {
  const uid = parseUserId(actorId);
  const gid = parseGroupId(groupId);
  if (uid === null) return { ok: false, error: "bad-actor", status: 400 };
  if (!gid) return { ok: false, error: "bad-group", status: 400 };

  const db = await getRedis();
  const raw = await db.get(gcKey(gid));
  if (!raw) return { ok: false, error: "not-found", status: 404 };
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not-found", status: 404 };
  }

  const members = Array.isArray(meta.members)
    ? meta.members.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!members.includes(uid)) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const rows = await db.lRange(gcMsgsKey(gid), 0, -1);
  const messages = [];
  for (const row of rows) {
    try {
      messages.push(JSON.parse(row));
    } catch {
      /* skip */
    }
  }

  // Rewrite labels from sender UID so bad/stale authorName can't mis-attribute.
  for (const msg of messages) {
    const from = parseUserId(msg?.from);
    if (from === null) continue;
    msg.authorName = await displayNameFor(from, msg.authorName);
    msg.from = from;
  }

  await db.hDel(unreadKey(uid), gcInboxValue(gid));

  return {
    ok: true,
    kind: "gc",
    groupId: gid,
    name: cleanText(meta.name, GC_NAME_MAX) || `Group ${gid}`,
    members,
    memberCount: members.length,
    messages,
    muted: await isMuted(uid),
    updatedAt: meta.updatedAt || null,
    lastPreview: meta.lastPreview || "",
  };
}

export async function sendGroupMessage({
  actorId,
  groupId,
  authorName,
  body,
  sessionCookie,
}) {
  const gid = parseGroupId(groupId);
  if (!gid) return { ok: false, error: "bad-group", status: 400 };

  const cleanBody = cleanText(body, DM_BODY_MAX);
  if (!cleanBody) return { ok: false, error: "bad-body", status: 400 };

  const identity = await resolveAuthor({
    authorId: actorId,
    authorName,
    sessionCookie,
    requireSession: false,
  });
  if (!identity.ok) return identity;
  const uid = identity.authorId;
  // Prefer live display name for this UID (ignore stale/wrong binds when possible).
  const name = await displayNameFor(uid, identity.authorName);

  if (await isMuted(uid)) {
    return { ok: false, error: "muted", status: 403 };
  }

  const db = await getRedis();
  const raw = await db.get(gcKey(gid));
  if (!raw) return { ok: false, error: "not-found", status: 404 };
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not-found", status: 404 };
  }

  const members = Array.isArray(meta.members)
    ? meta.members.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!members.includes(uid)) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const last = await db.get(rateKey(uid));
  if (last) {
    const elapsed = Date.now() - Number(last);
    if (elapsed >= 0 && elapsed < DM_RATE_MS) {
      return { ok: false, error: "rate-limited", status: 429 };
    }
  }

  const now = new Date().toISOString();
  const msg = {
    id: String(await nextMsgId(db)),
    from: uid,
    authorName: name,
    body: cleanBody,
    createdAt: now,
  };

  meta.updatedAt = now;
  meta.lastFrom = uid;
  meta.lastPreview = `${name}: ${cleanBody}`.slice(0, 120);
  meta.members = members;

  const score = Date.now();
  const inboxVal = gcInboxValue(gid);
  await db.rPush(gcMsgsKey(gid), JSON.stringify(msg));
  await db.set(gcKey(gid), JSON.stringify(meta));
  for (const mid of members) {
    await db.zAdd(userThreadsKey(mid), { score, value: inboxVal });
    if (mid !== uid) {
      await db.hIncrBy(unreadKey(mid), inboxVal, 1);
    }
  }
  await db.set(rateKey(uid), String(score), { PX: DM_RATE_MS });

  const logEntry = {
    id: msg.id,
    threadId: inboxVal,
    groupId: gid,
    from: uid,
    fromName: name,
    to: null,
    body: cleanBody.slice(0, 200),
    createdAt: now,
  };
  await db.lPush(modlogKey(), JSON.stringify(logEntry));
  await db.lTrim(modlogKey(), 0, DM_MODLOG_MAX - 1);

  return {
    ok: true,
    groupId: gid,
    message: msg,
    meta: {
      id: gid,
      name: meta.name,
      members,
      updatedAt: now,
      lastPreview: meta.lastPreview,
    },
  };
}

export async function listModLogs(actorId, limit = 50) {
  if (!canModerateForum(actorId)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  const db = await getRedis();
  const n = Math.min(100, Math.max(1, Number(limit) || 50));
  const rows = await db.lRange(modlogKey(), 0, n - 1);
  const logs = [];
  for (const row of rows) {
    try {
      logs.push(JSON.parse(row));
    } catch {
      /* skip */
    }
  }
  return { ok: true, logs };
}

export async function listMuted(actorId) {
  if (!canModerateForum(actorId)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  const db = await getRedis();
  const all = (await db.hGetAll(mutedKey())) || {};
  const muted = [];
  for (const [uid, raw] of Object.entries(all)) {
    let info = {};
    try {
      info = JSON.parse(raw);
    } catch {
      info = {};
    }
    muted.push({
      userId: Number(uid),
      reason: info.reason || "",
      by: info.by ?? null,
      at: info.at || null,
    });
  }
  muted.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return { ok: true, muted };
}

export async function muteUser({ actorId, targetId, reason }) {
  if (!canModerateForum(actorId)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  const mod = parseUserId(actorId);
  const target = parseUserId(targetId);
  if (target === null) return { ok: false, error: "bad-target", status: 400 };
  if (FORUM_MOD_IDS.has(target)) {
    return { ok: false, error: "cannot-mute-mod", status: 400 };
  }

  const db = await getRedis();
  const entry = {
    reason: cleanText(reason, 200) || "Restricted from messaging",
    by: mod,
    at: new Date().toISOString(),
  };
  await db.hSet(mutedKey(), String(target), JSON.stringify(entry));
  return { ok: true, userId: target, ...entry };
}

export async function unmuteUser({ actorId, targetId }) {
  if (!canModerateForum(actorId)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  const target = parseUserId(targetId);
  if (target === null) return { ok: false, error: "bad-target", status: 400 };

  const db = await getRedis();
  await db.hDel(mutedKey(), String(target));
  return { ok: true, userId: target, unmuted: true };
}

/**
 * Rewrite DM thread aName/bName from canonical usernames.
 * Stops old spoofed peer labels from living in Redis forever.
 */
export async function repairDmThreadNames() {
  const db = await getRedis();
  let scanned = 0;
  let updated = 0;
  let cursor = 0;
  do {
    const res = await db.scan(cursor, {
      MATCH: "dm:thread:*",
      COUNT: 200,
    });
    cursor = Number(res.cursor ?? 0);
    for (const key of res.keys ?? []) {
      // Skip message lists: dm:thread:{id}:msgs
      if (String(key).endsWith(":msgs")) continue;
      scanned += 1;
      const raw = await db.get(key);
      if (!raw) continue;
      let meta;
      try {
        meta = JSON.parse(raw);
      } catch {
        continue;
      }
      const a = parseUserId(meta.a);
      const b = parseUserId(meta.b);
      if (a === null || b === null) continue;
      const aName = await displayNameFor(a, meta.aName);
      const bName = await displayNameFor(b, meta.bName);
      if (meta.aName === aName && meta.bName === bName) continue;
      meta.aName = aName;
      meta.bName = bName;
      await db.set(key, JSON.stringify(meta));
      updated += 1;
    }
  } while (cursor !== 0);
  return { ok: true, scanned, updated };
}
