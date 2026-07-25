import { createClient } from "redis";
import { FORUM_MOD_IDS } from "../../../lib/forum.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** One-shot data repair for thread 1 OP. Mod-only. */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const actorId = Number(body?.actorId);
  if (!Number.isInteger(actorId) || !FORUM_MOD_IDS.has(actorId)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const url = process.env.REDIS_URL;
  if (!url) return json({ ok: false, error: "REDIS_URL missing" }, 500);

  const db = createClient({ url });
  await db.connect();
  try {
    const raw = await db.get("forum:thread:1");
    if (!raw) return json({ ok: false, error: "thread-missing" }, 404);
    const thread = JSON.parse(raw);
    const posts = (await db.lRange("forum:thread:1:posts", 0, -1)).map((p) =>
      JSON.parse(p),
    );
    if (posts.some((p) => String(p.id) === "1")) {
      return json({ ok: true, repaired: false, reason: "op-present" });
    }
    const op = {
      id: "1",
      threadId: "1",
      authorId: 15936,
      authorName: "Kiri",
      body: "Welcome to the Vortex07 Forum! Post bugs, ideas, and chat here.",
      createdAt: thread.createdAt || "2026-07-24T22:56:04.310Z",
    };
    const rebuilt = [op, ...posts];
    await db.del("forum:thread:1:posts");
    await db.rPush(
      "forum:thread:1:posts",
      ...rebuilt.map((p) => JSON.stringify(p)),
    );
    thread.replyCount = Math.max(0, rebuilt.length - 1);
    thread.updatedAt = rebuilt[rebuilt.length - 1]?.createdAt || thread.updatedAt;
    await db.set("forum:thread:1", JSON.stringify(thread));
    return json({ ok: true, repaired: true, posts: rebuilt.length });
  } finally {
    await db.quit();
  }
}
