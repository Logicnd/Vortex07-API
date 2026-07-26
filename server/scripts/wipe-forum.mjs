/**
 * Delete all forum:* Redis keys and reset thread/post counters.
 * Keeps identity, comments, DMs, likes, ratings.
 *
 * Usage (from server/): node scripts/wipe-forum.mjs
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

const keys = [];
let cursor = 0;
do {
  const res = await db.scan(cursor, { MATCH: "forum:*", COUNT: 200 });
  cursor = Number(res.cursor ?? 0);
  keys.push(...(res.keys ?? []));
} while (cursor !== 0);

console.log("deleting", keys.length, "forum keys");
if (keys.length) await db.del(keys);

await db.set("forum:meta:next:thread", "0");
await db.set("forum:meta:next:post", "0");

const left = [];
cursor = 0;
do {
  const res = await db.scan(cursor, { MATCH: "forum:*", COUNT: 200 });
  cursor = Number(res.cursor ?? 0);
  left.push(...(res.keys ?? []));
} while (cursor !== 0);

console.log("remaining", left.sort());
await db.quit();
console.log("forum wipe complete");
