/**
 * Create a single welcome thread after a wipe (idempotent if threads exist).
 * Usage: node scripts/seed-forum-welcome.mjs
 */
import fs from "fs";
import path from "path";
import { createClient } from "redis";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function loadRedisUrl() {
  for (const file of [".env.production.local", ".env.local"]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^REDIS_URL=(.*)$/m);
    if (!m) continue;
    let url = m[1].trim();
    if (
      (url.startsWith('"') && url.endsWith('"')) ||
      (url.startsWith("'") && url.endsWith("'"))
    ) {
      url = url.slice(1, -1);
    }
    if (url) return url;
  }
  return process.env.REDIS_URL || "";
}

const url = loadRedisUrl();
if (!url) {
  console.error("NO_REDIS_URL");
  process.exit(1);
}

const db = createClient({ url });
await db.connect();

const existing = await db.zCard("forum:cat:general:threads");
if (existing > 0) {
  console.log("skip seed — general already has", existing, "threads");
  await db.quit();
  process.exit(0);
}

const now = new Date().toISOString();
const threadId = String(await db.incr("forum:meta:next:thread"));
const postId = String(await db.incr("forum:meta:next:post"));

const thread = {
  id: threadId,
  categoryId: "general",
  title: "Welcome to the Vortex07 Forum",
  authorId: 15936,
  authorName: "Kiri",
  createdAt: now,
  updatedAt: now,
  replyCount: 0,
};

const op = {
  id: postId,
  threadId,
  authorId: 15936,
  authorName: "Kiri",
  body: "Fresh start. Post bugs, ideas, and chat — usernames follow your playvortex ID.",
  createdAt: now,
};

await db.set(`forum:thread:${threadId}`, JSON.stringify(thread));
await db.rPush(`forum:thread:${threadId}:posts`, JSON.stringify(op));
await db.zAdd("forum:cat:general:threads", {
  score: Date.now(),
  value: threadId,
});
await db.set("identity:user:15936", "Kiri");
await db.set("identity:name:kiri", "15936");

console.log("seeded welcome thread", threadId, "post", postId);
await db.quit();
