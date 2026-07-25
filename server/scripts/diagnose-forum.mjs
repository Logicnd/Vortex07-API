import fs from "fs";
import { createClient } from "redis";

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    if (!process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

loadEnv(".env.production.local");
loadEnv(".env.local");

const url = process.env.REDIS_URL;
if (!url) {
  console.log(JSON.stringify({ error: "no-redis-url" }));
  process.exit(1);
}

const db = createClient({ url });
db.on("error", (e) => console.error("redis", e.message));
await db.connect();

const forumKeys = [];
let cursor = "0";
do {
  const res = await db.scan(cursor, { MATCH: "forum:*", COUNT: 200 });
  cursor = String(res.cursor);
  forumKeys.push(...res.keys);
} while (cursor !== "0");

const threadKeys = forumKeys.filter((k) => /^forum:thread:\d+$/.test(k));
const postKeys = forumKeys.filter((k) => /^forum:thread:\d+:posts$/.test(k));
const catKeys = forumKeys.filter((k) => /^forum:cat:/.test(k));
const metaKeys = forumKeys.filter((k) => k.startsWith("forum:meta:"));

const cats = {};
for (const ck of catKeys) {
  cats[ck] = await db.zCard(ck);
}

const spot = {};
for (const id of ["1", "3", "5", "6"]) {
  const raw = await db.get("forum:thread:" + id);
  const posts = await db.lLen("forum:thread:" + id + ":posts");
  spot[id] = {
    thread: Boolean(raw),
    posts: Number(posts) || 0,
    title: raw ? JSON.parse(raw).title || null : null,
  };
}

const nextThread = await db.get("forum:meta:next:thread");
const nextPost = await db.get("forum:meta:next:post");

const inIndex = new Set();
for (const ck of catKeys) {
  const ids = await db.zRange(ck, 0, -1);
  ids.forEach((id) => inIndex.add(String(id)));
}
const orphans = threadKeys
  .map((k) => k.replace("forum:thread:", ""))
  .filter((id) => !inIndex.has(id));

console.log(
  JSON.stringify(
    {
      forumKeyCount: forumKeys.length,
      threadKeys: threadKeys.length,
      postKeys: postKeys.length,
      catKeys,
      cats,
      metaKeys,
      nextThread,
      nextPost,
      spot,
      orphanThreadIds: orphans.slice(0, 50),
      orphanCount: orphans.length,
      sampleForumKeys: forumKeys.slice(0, 40),
    },
    null,
    2,
  ),
);

await db.quit();
