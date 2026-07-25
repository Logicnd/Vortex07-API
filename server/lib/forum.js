import { createClient } from "redis";

/** @type {import('redis').RedisClientType | null} */
let client = null;

export const FORUM_TITLE_MAX = 120;
export const FORUM_BODY_MAX = 4000;

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

async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL missing");
  if (!client) {
    client = createClient({ url });
    client.on("error", (err) => console.error("redis error", err));
    await client.connect();
  } else if (!client.isOpen) {
    await client.connect();
  }
  return client;
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
  const uid = parseUserId(authorId);
  if (!cleanTitle || !cleanBody) {
    return { ok: false, error: "bad-body", status: 400 };
  }
  if (uid === null) {
    return { ok: false, error: "bad-actor", status: 400 };
  }

  const id = String(await nextId(db, "thread"));
  const now = new Date().toISOString();
  const name = cleanText(authorName, 40) || `Player ${uid}`;
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

export async function renameAuthor({ authorId, authorName }) {
  const db = await getRedis();
  const uid = parseUserId(authorId);
  const name = cleanText(authorName, 40);
  if (uid === null || !name) {
    return { ok: false, error: "bad-actor", status: 400 };
  }

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
  const uid = parseUserId(authorId);
  if (!cleanBody) return { ok: false, error: "bad-body", status: 400 };
  if (uid === null) return { ok: false, error: "bad-actor", status: 400 };

  const now = new Date().toISOString();
  const post = {
    id: String(await nextId(db, "post")),
    threadId: id,
    authorId: uid,
    authorName: cleanText(authorName, 40) || `Player ${uid}`,
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
  if (!isAuthor && !canModerateForum(actorId)) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const now = new Date().toISOString();
  post.body = cleanBody;
  post.editedAt = now;

  await db.lSet(postsKey(tid), index, JSON.stringify(post));

  // OP edit may rename the thread (author or mod)
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

  // Deleting the OP while replies remain would orphan the thread — require
  // full thread delete instead.
  if (removedIndex === 0 && posts.length > 0) {
    return { ok: false, error: "delete-thread-instead", status: 400 };
  }

  // Last post gone → remove the whole thread
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
