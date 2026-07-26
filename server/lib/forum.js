import { getRedis } from "./redis.js";
import { hitRateLimit } from "./rate-limit.js";
import {
  cleanUsername,
  isPlaceholderUsername,
  namesMatch,
  parseUserId as parseIdentityId,
  resolveAuthor,
  setBoundUsername,
  getBoundUsername,
} from "./identity.js";

export const FORUM_TITLE_MAX = 120;
export const FORUM_BODY_MAX = 4000;
/** One new thread / 15s per user. */
export const FORUM_THREAD_RATE_MS = 15_000;
/** One reply / 3s per user. */
export const FORUM_REPLY_RATE_MS = 3_000;

/** Vortex07 extension developers (+ site owner) may delete any thread/post. */
export const FORUM_MOD_IDS = new Set([1, 15936, 18202, 22795]);

export const FORUM_CATEGORIES = [
  { id: "general", label: "General Discussion" },
  { id: "help", label: "Help & Support" },
  { id: "offtopic", label: "Off Topic" },
];

export function canModerateForum(actorId) {
  const uid = parseUserId(actorId);
  return uid !== null && FORUM_MOD_IDS.has(uid);
}

function catKey(categoryId) {
  return `forum:cat:${categoryId}:threads`;
}

function threadKey(threadId) {
  return `forum:thread:${threadId}`;
}

function postsKey(threadId) {
  return `forum:thread:${threadId}:posts`;
}

export function normalizeCategoryId(raw) {
  const id = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (FORUM_CATEGORIES.some((c) => c.id === id)) return id;
  return "general";
}

export function listCategories() {
  return FORUM_CATEGORIES.map((c) => ({ ...c }));
}

function parseUserId(value) {
  return parseIdentityId(value);
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, max);
}

async function nextId(db, kind) {
  return Number(await db.incr(`forum:meta:next:${kind}`));
}

export async function listThreads(categoryId, limit = 30, offset = 0) {
  const db = await getRedis();
  const cat = normalizeCategoryId(categoryId);
  const start = Math.max(0, Number(offset) || 0);
  const stop = start + Math.min(50, Math.max(1, Number(limit) || 30)) - 1;
  const ids = await db.zRange(catKey(cat), start, stop, { REV: true });
  const threads = [];
  for (const id of ids) {
    const raw = await db.get(threadKey(id));
    if (!raw) continue;
    try {
      threads.push(JSON.parse(raw));
    } catch {
      /* skip */
    }
  }
  return { categoryId: cat, threads };
}

export async function getThread(threadId) {
  const db = await getRedis();
  const id = String(threadId || "");
  const raw = await db.get(threadKey(id));
  if (!raw) return null;
  let thread;
  try {
    thread = JSON.parse(raw);
  } catch {
    return null;
  }
  const postRaw = await db.lRange(postsKey(id), 0, -1);
  const posts = [];
  for (const row of postRaw) {
    try {
      posts.push(JSON.parse(row));
    } catch {
      /* skip */
    }
  }
  return { thread, posts };
}

export async function createThread({ categoryId, title, body, authorId, authorName }) {
  const db = await getRedis();
  const cat = normalizeCategoryId(categoryId);
  const cleanTitle = cleanText(title, FORUM_TITLE_MAX);
  const cleanBody = cleanText(body, FORUM_BODY_MAX);
  if (!cleanTitle || !cleanBody) {
    return { ok: false, error: "bad-body", status: 400 };
  }

  const identity = await resolveAuthor({ authorId, authorName });
  if (!identity.ok) return identity;
  const uid = identity.authorId;
  const name = identity.authorName;

  const rate = await hitRateLimit(
    db,
    `forum:rate:thread:${uid}`,
    FORUM_THREAD_RATE_MS,
  );
  if (rate.limited) {
    return {
      ok: false,
      error: "rate-limited",
      retryAfter: rate.retryAfterSec,
      status: 429,
    };
  }

  const id = String(await nextId(db, "thread"));
  const now = new Date().toISOString();
  const thread = {
    id,
    categoryId: cat,
    title: cleanTitle,
    authorId: uid,
    authorName: name,
    createdAt: now,
    updatedAt: now,
    replyCount: 0,
  };
  const op = {
    id: String(await nextId(db, "post")),
    threadId: id,
    authorId: uid,
    authorName: name,
    body: cleanBody,
    createdAt: now,
  };

  await db.set(threadKey(id), JSON.stringify(thread));
  await db.rPush(postsKey(id), JSON.stringify(op));
  await db.zAdd(catKey(cat), { score: Date.now(), value: id });

  return { ok: true, thread, posts: [op] };
}

/**
 * Mod-only: rebind an author's stored display name after identity checks.
 * Open rename was a spoof vector (any client could rewrite any authorId).
 */
export async function renameAuthor({ authorId, authorName, actorId }) {
  if (!canModerateForum(actorId)) {
    return { ok: false, error: "forbidden", status: 403 };
  }
  const uid = parseUserId(authorId);
  const name = cleanUsername(authorName);
  if (uid === null || !name || isPlaceholderUsername(name)) {
    return { ok: false, error: "bad-actor", status: 400 };
  }

  await setBoundUsername(uid, name);

  const db = await getRedis();
  let updated = 0;
  for (const cat of FORUM_CATEGORIES) {
    const ids = await db.zRange(catKey(cat.id), 0, -1);
    for (const id of ids) {
      const raw = await db.get(threadKey(id));
      if (!raw) continue;
      let thread;
      try {
        thread = JSON.parse(raw);
      } catch {
        continue;
      }
      let dirty = false;
      if (Number(thread.authorId) === uid && thread.authorName !== name) {
        thread.authorName = name;
        dirty = true;
      }
      if (dirty) {
        await db.set(threadKey(id), JSON.stringify(thread));
        updated += 1;
      }

      const posts = await db.lRange(postsKey(id), 0, -1);
      for (let i = 0; i < posts.length; i += 1) {
        let post;
        try {
          post = JSON.parse(posts[i]);
        } catch {
          continue;
        }
        if (Number(post.authorId) === uid && post.authorName !== name) {
          post.authorName = name;
          await db.lSet(postsKey(id), i, JSON.stringify(post));
          updated += 1;
        }
      }
    }
  }

  return { ok: true, authorId: uid, authorName: name, updated };
}

export async function replyToThread({ threadId, body, authorId, authorName }) {
  const db = await getRedis();
  const id = String(threadId || "");
  const raw = await db.get(threadKey(id));
  if (!raw) return { ok: false, error: "not-found", status: 404 };

  let thread;
  try {
    thread = JSON.parse(raw);
  } catch {
    return { ok: false, error: "corrupt", status: 500 };
  }

  const cleanBody = cleanText(body, FORUM_BODY_MAX);
  if (!cleanBody) return { ok: false, error: "bad-body", status: 400 };

  const identity = await resolveAuthor({ authorId, authorName });
  if (!identity.ok) return identity;
  const uid = identity.authorId;
  const name = identity.authorName;

  const rate = await hitRateLimit(
    db,
    `forum:rate:reply:${uid}`,
    FORUM_REPLY_RATE_MS,
  );
  if (rate.limited) {
    return {
      ok: false,
      error: "rate-limited",
      retryAfter: rate.retryAfterSec,
      status: 429,
    };
  }

  const now = new Date().toISOString();
  const post = {
    id: String(await nextId(db, "post")),
    threadId: id,
    authorId: uid,
    authorName: name,
    body: cleanBody,
    createdAt: now,
  };

  thread.updatedAt = now;
  thread.replyCount = Number(thread.replyCount || 0) + 1;

  await db.rPush(postsKey(id), JSON.stringify(post));
  await db.set(threadKey(id), JSON.stringify(thread));
  await db.zAdd(catKey(thread.categoryId), { score: Date.now(), value: id });

  return { ok: true, thread, post };
}

/**
 * Authors may edit their own posts. When editing the first post, they may
 * also rename the thread title (same actor must own the post).
 */
export async function editPost({ threadId, postId, actorId, body, title }) {
  const db = await getRedis();
  const tid = String(threadId || "");
  const pid = String(postId || "");
  const uid = parseUserId(actorId);
  if (!tid || !pid) return { ok: false, error: "bad-id", status: 400 };
  if (uid === null) return { ok: false, error: "bad-actor", status: 400 };

  const raw = await db.get(threadKey(tid));
  if (!raw) return { ok: false, error: "not-found", status: 404 };

  let thread;
  try {
    thread = JSON.parse(raw);
  } catch {
    return { ok: false, error: "corrupt", status: 500 };
  }

  const cleanBody = cleanText(body, FORUM_BODY_MAX);
  if (!cleanBody) return { ok: false, error: "bad-body", status: 400 };

  const postRaw = await db.lRange(postsKey(tid), 0, -1);
  let index = -1;
  let post = null;
  for (let i = 0; i < postRaw.length; i += 1) {
    try {
      const row = JSON.parse(postRaw[i]);
      if (String(row.id) === pid) {
        index = i;
        post = row;
        break;
      }
    } catch {
      /* skip */
    }
  }

  if (!post || index < 0) {
    return { ok: false, error: "post-not-found", status: 404 };
  }
  const isAuthor = Number(post.authorId) === uid;
  if (!isAuthor) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const now = new Date().toISOString();
  post.body = cleanBody;
  post.editedAt = now;

  await db.lSet(postsKey(tid), index, JSON.stringify(post));

  // OP author may rename the thread title
  if (index === 0 && title !== undefined && title !== null) {
    const cleanTitle = cleanText(title, FORUM_TITLE_MAX);
    if (!cleanTitle) return { ok: false, error: "bad-title", status: 400 };
    thread.title = cleanTitle;
  }
  thread.updatedAt = now;
  await db.set(threadKey(tid), JSON.stringify(thread));
  await db.zAdd(catKey(thread.categoryId), { score: Date.now(), value: tid });

  return { ok: true, thread, post };
}

export async function deleteThread({ threadId, actorId }) {
  const db = await getRedis();
  const id = String(threadId || "");
  const uid = parseUserId(actorId);
  const raw = await db.get(threadKey(id));
  if (!raw) return { ok: false, error: "not-found", status: 404 };

  let thread;
  try {
    thread = JSON.parse(raw);
  } catch {
    thread = { id, categoryId: "general" };
  }

  const isOwner = uid !== null && Number(thread.authorId) === uid;
  if (!canModerateForum(actorId) && !isOwner) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const cat = normalizeCategoryId(thread.categoryId);
  await db.del(threadKey(id));
  await db.del(postsKey(id));
  await db.zRem(catKey(cat), id);

  return { ok: true, deleted: "thread", threadId: id };
}

export async function deletePost({ threadId, postId, actorId }) {
  const db = await getRedis();
  const tid = String(threadId || "");
  const pid = String(postId || "");
  const uid = parseUserId(actorId);
  if (!tid || !pid) return { ok: false, error: "bad-id", status: 400 };
  if (uid === null) return { ok: false, error: "bad-actor", status: 400 };

  const raw = await db.get(threadKey(tid));
  if (!raw) return { ok: false, error: "not-found", status: 404 };

  let thread;
  try {
    thread = JSON.parse(raw);
  } catch {
    return { ok: false, error: "corrupt", status: 500 };
  }

  const postRaw = await db.lRange(postsKey(tid), 0, -1);
  const posts = [];
  let removed = false;
  let removedPost = null;
  let removedIndex = -1;
  for (let i = 0; i < postRaw.length; i += 1) {
    try {
      const post = JSON.parse(postRaw[i]);
      if (String(post.id) === pid) {
        removed = true;
        removedPost = post;
        removedIndex = i;
        continue;
      }
      posts.push(post);
    } catch {
      /* skip corrupt */
    }
  }

  if (!removed || !removedPost) {
    return { ok: false, error: "post-not-found", status: 404 };
  }

  const isAuthor = Number(removedPost.authorId) === uid;
  if (!canModerateForum(actorId) && !isAuthor) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  // Deleting the OP while replies remain would orphan the thread ÔÇö require
  // full thread delete instead.
  if (removedIndex === 0 && posts.length > 0) {
    return { ok: false, error: "delete-thread-instead", status: 400 };
  }

  // Last post gone ÔåÆ remove the whole thread
  if (posts.length === 0) {
    const cat = normalizeCategoryId(thread.categoryId);
    await db.del(threadKey(tid));
    await db.del(postsKey(tid));
    await db.zRem(catKey(cat), tid);
    return { ok: true, deleted: "thread", threadId: tid, postId: pid };
  }

  await db.del(postsKey(tid));
  if (posts.length) {
    await db.rPush(postsKey(tid), ...posts.map((p) => JSON.stringify(p)));
  }

  thread.replyCount = Math.max(0, posts.length - 1);
  const last = posts[posts.length - 1];
  thread.updatedAt = last?.createdAt || thread.updatedAt;
  await db.set(threadKey(tid), JSON.stringify(thread));

  return { ok: true, deleted: "post", threadId: tid, postId: pid, thread };
}

/**
 * Rebuild category sorted-set indexes from surviving forum:thread:* keys.
 * Also realign forum:meta:next:* counters to max existing ids.
 */
export async function rebuildForumIndex() {
  const db = await getRedis();
  const catIds = FORUM_CATEGORIES.map((c) => c.id);
  const indexed = {};
  for (const id of catIds) indexed[id] = 0;

  let cursor = 0;
  const threadIds = new Set();
  do {
    const res = await db.scan(cursor, { MATCH: "forum:thread:*", COUNT: 200 });
    cursor = Number(res.cursor ?? res[0] ?? 0);
    const keys = res.keys ?? res[1] ?? [];
    for (const key of keys) {
      const k = String(key);
      if (k.includes(":posts")) continue;
      const id = k.slice("forum:thread:".length);
      if (id && !id.includes(":")) threadIds.add(id);
    }
  } while (cursor !== 0);

  for (const cat of catIds) {
    await db.del(catKey(cat));
  }

  let maxThread = 0;
  let maxPost = 0;
  let threads = 0;

  for (const id of threadIds) {
    const raw = await db.get(threadKey(id));
    if (!raw) continue;
    let thread;
    try {
      thread = JSON.parse(raw);
    } catch {
      continue;
    }
    const cat = normalizeCategoryId(thread.categoryId);
    const score = Date.parse(thread.updatedAt || thread.createdAt || "") || Number(id) || 0;
    await db.zAdd(catKey(cat), [{ score, value: String(id) }]);
    indexed[cat] = (indexed[cat] || 0) + 1;
    threads += 1;
    const n = Number(id);
    if (Number.isInteger(n) && n > maxThread) maxThread = n;

    const postRaw = await db.lRange(postsKey(id), 0, -1);
    for (const row of postRaw) {
      try {
        const post = JSON.parse(row);
        const pn = Number(post.id);
        if (Number.isInteger(pn) && pn > maxPost) maxPost = pn;
      } catch {
        /* skip */
      }
    }
  }

  if (maxThread > 0) await db.set(`forum:meta:next:thread`, String(maxThread));
  if (maxPost > 0) await db.set(`forum:meta:next:post`, String(maxPost));

  return {
    ok: true,
    threads,
    indexed,
    maxThread,
    maxPost,
  };
}

/** Read-only scan of forum:* key shapes for diagnostics. */
export async function diagnoseForumKeys() {
  const db = await getRedis();
  const counts = {
    threadKeys: 0,
    postLists: 0,
    categoryZsets: 0,
    categoryLists: 0,
    meta: 0,
    other: 0,
  };
  const samples = { threads: [], cats: [], meta: [] };
  let cursor = 0;
  do {
    const res = await db.scan(cursor, { MATCH: "forum:*", COUNT: 200 });
    cursor = Number(res.cursor ?? res[0] ?? 0);
    const keys = res.keys ?? res[1] ?? [];
    for (const key of keys) {
      const k = String(key);
      if (k.startsWith("forum:thread:") && k.endsWith(":posts")) {
        counts.postLists += 1;
      } else if (k.startsWith("forum:thread:")) {
        counts.threadKeys += 1;
        if (samples.threads.length < 12) samples.threads.push(k);
      } else if (k.startsWith("forum:cat:") && k.endsWith(":threads")) {
        counts.categoryZsets += 1;
        if (samples.cats.length < 12) {
          const card = await db.zCard(k);
          samples.cats.push({ key: k, zcard: card });
        }
      } else if (k.startsWith("forum:cat:")) {
        counts.categoryLists += 1;
        if (samples.cats.length < 12) {
          const len = await db.lLen(k).catch(() => null);
          samples.cats.push({ key: k, llen: len });
        }
      } else if (k.startsWith("forum:meta:")) {
        counts.meta += 1;
        if (samples.meta.length < 8) {
          samples.meta.push({ key: k, value: await db.get(k) });
        }
      } else {
        counts.other += 1;
      }
    }
  } while (cursor !== 0);

  const spot = {};
  for (const id of ["1", "3", "5", "6"]) {
    const raw = await db.get(threadKey(id));
    spot[id] = raw
      ? (() => {
          try {
            const t = JSON.parse(raw);
            return {
              exists: true,
              title: t.title,
              categoryId: t.categoryId,
              authorName: t.authorName,
              replyCount: t.replyCount,
            };
          } catch {
            return { exists: true, corrupt: true };
          }
        })()
      : { exists: false };
  }

  return { ok: true, counts, samples, spot };
}

/**
 * Partial reseed for known threads when Redis bodies are gone.
 * Does not invent reply history.
 */
export async function reseedKnownForumThreads() {
  const db = await getRedis();
  const seeds = [
    {
      id: "1",
      categoryId: "general",
      title: "Welcome to the Vortex07 Forum",
      authorId: 15936,
      authorName: "Kiri",
      createdAt: "2026-07-24T22:56:04.310Z",
      body: "Welcome to the Vortex07 Forum! Post bugs, ideas, and chat here.",
      postId: "1",
    },
  ];
  const created = [];
  for (const seed of seeds) {
    const existing = await db.get(threadKey(seed.id));
    if (existing) {
      created.push({ id: seed.id, status: "exists" });
      continue;
    }
    const thread = {
      id: seed.id,
      categoryId: seed.categoryId,
      title: seed.title,
      authorId: seed.authorId,
      authorName: seed.authorName,
      createdAt: seed.createdAt,
      updatedAt: seed.createdAt,
      replyCount: 0,
    };
    const op = {
      id: seed.postId,
      threadId: seed.id,
      authorId: seed.authorId,
      authorName: seed.authorName,
      body: seed.body,
      createdAt: seed.createdAt,
    };
    await db.set(threadKey(seed.id), JSON.stringify(thread));
    await db.del(postsKey(seed.id));
    await db.rPush(postsKey(seed.id), JSON.stringify(op));
    const score = Date.parse(seed.createdAt) || Date.now();
    await db.zAdd(catKey(seed.categoryId), [{ score, value: seed.id }]);
    created.push({ id: seed.id, status: "seeded" });
  }
  const rebuild = await rebuildForumIndex();
  return { ok: true, created, rebuild };
}

/**
 * Scan all forum posts, bind consistent high-trust names, and remove spoofs:
 * - placeholder / repeated-char names
 * - authorIds with conflicting names (keep majority non-placeholder)
 * - low-id one-shot flood posts (classic old-API spoof dump)
 */
export async function purgeSpoofedForum() {
  const db = await getRedis();
  const nameCounts = new Map(); // id -> Map(nameLower -> { name, count })
  const idPostCount = new Map();
  const threadMeta = [];

  for (const cat of FORUM_CATEGORIES) {
    const ids = await db.zRange(catKey(cat.id), 0, -1);
    for (const id of ids) {
      const raw = await db.get(threadKey(id));
      if (!raw) continue;
      let thread;
      try {
        thread = JSON.parse(raw);
      } catch {
        continue;
      }
      const posts = [];
      for (const row of await db.lRange(postsKey(id), 0, -1)) {
        try {
          posts.push(JSON.parse(row));
        } catch {
          /* skip */
        }
      }
      threadMeta.push({ id: String(id), cat: cat.id, thread, posts });

      for (const post of posts) {
        const uid = parseUserId(post.authorId);
        if (uid === null) continue;
        idPostCount.set(uid, (idPostCount.get(uid) || 0) + 1);
        const name = cleanUsername(post.authorName) || `Player ${uid}`;
        const key = name.toLowerCase();
        if (!nameCounts.has(uid)) nameCounts.set(uid, new Map());
        const bucket = nameCounts.get(uid);
        const cur = bucket.get(key) || { name, count: 0 };
        cur.count += 1;
        bucket.set(key, cur);
      }
    }
  }

  // Pick canonical name per id (majority non-placeholder). Bind trusted ones.
  const canonical = new Map();
  for (const [uid, bucket] of nameCounts.entries()) {
    const ranked = [...bucket.values()].sort((a, b) => b.count - a.count);
    const good = ranked.find((r) => !isPlaceholderUsername(r.name));
    if (good && (good.count >= 2 || uid >= 1000 || FORUM_MOD_IDS.has(uid))) {
      canonical.set(uid, good.name);
      await setBoundUsername(uid, good.name);
    } else if (good && ranked.length === 1 && uid >= 1000) {
      canonical.set(uid, good.name);
      await setBoundUsername(uid, good.name);
    }
  }

  // Seed known mods from existing data if present
  for (const uid of FORUM_MOD_IDS) {
    const bound = await getBoundUsername(uid);
    if (bound) canonical.set(uid, bound);
  }

  let removedPosts = 0;
  let rewritten = 0;
  let removedThreads = 0;
  const removedSample = [];

  function isSpoofPost(post, threadPostCount) {
    const uid = parseUserId(post.authorId);
    const name = cleanUsername(post.authorName);
    if (uid === null) return true;
    if (isPlaceholderUsername(name)) return true;

    const canon = canonical.get(uid);
    if (canon && !namesMatch(name, canon)) return true;

    const variants = nameCounts.get(uid);
    if (variants && variants.size > 1 && !canon) {
      // Conflicting names and no trustworthy canonical → drop all
      return true;
    }

    // Low-id one-shot flood (old open API dump)
    if (
      uid < 1000 &&
      !FORUM_MOD_IDS.has(uid) &&
      (idPostCount.get(uid) || 0) <= 2 &&
      threadPostCount >= 20
    ) {
      return true;
    }

    return false;
  }

  for (const entry of threadMeta) {
    const { id, thread, posts } = entry;
    const kept = [];
    for (const post of posts) {
      if (isSpoofPost(post, posts.length)) {
        removedPosts += 1;
        if (removedSample.length < 40) {
          removedSample.push({
            threadId: id,
            postId: post.id,
            authorId: post.authorId,
            authorName: post.authorName,
          });
        }
        continue;
      }
      const uid = parseUserId(post.authorId);
      const canon = uid !== null ? canonical.get(uid) : null;
      if (canon && !namesMatch(post.authorName, canon)) {
        post.authorName = canon;
        rewritten += 1;
      }
      kept.push(post);
    }

    if (kept.length === 0) {
      const cat = normalizeCategoryId(thread.categoryId);
      await db.del(threadKey(id));
      await db.del(postsKey(id));
      await db.zRem(catKey(cat), id);
      removedThreads += 1;
      continue;
    }

    // If OP was removed, promote first kept post as OP metadata
    const op = kept[0];
    thread.authorId = op.authorId;
    thread.authorName = op.authorName;
    thread.replyCount = Math.max(0, kept.length - 1);
    thread.updatedAt =
      kept[kept.length - 1]?.createdAt || thread.updatedAt || thread.createdAt;

    await db.del(postsKey(id));
    if (kept.length) {
      await db.rPush(postsKey(id), ...kept.map((p) => JSON.stringify(p)));
    }
    await db.set(threadKey(id), JSON.stringify(thread));
  }

  const rebuild = await rebuildForumIndex();
  return {
    ok: true,
    removedPosts,
    rewritten,
    removedThreads,
    boundUsers: canonical.size,
    removedSample,
    rebuild,
  };
}


