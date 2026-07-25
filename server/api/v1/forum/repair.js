import {
  canModerateForum,
  diagnoseForumKeys,
  FORUM_MOD_IDS,
  rebuildForumIndex,
  reseedKnownForumThreads,
} from "../../../lib/forum.js";
import { getRedis } from "../../../lib/redis.js";

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

function resolveAction(request, body) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("action");
  if (fromQuery) return String(fromQuery).toLowerCase();
  if (body?.action) return String(body.action).toLowerCase();
  // Path aliases: /v1/forum/diagnose|rebuild-index|reseed|repair
  const m = url.pathname.match(
    /\/(?:api\/)?v1\/forum\/(diagnose|rebuild-index|reseed|repair)\/?$/i,
  );
  if (m) return m[1].toLowerCase();
  return "repair";
}

/** Repair OP for thread 1 (legacy). */
async function repairThread1Op() {
  const db = await getRedis();
  const raw = await db.get("forum:thread:1");
  if (!raw) return { ok: false, error: "thread-missing", status: 404 };
  const thread = JSON.parse(raw);
  const posts = (await db.lRange("forum:thread:1:posts", 0, -1)).map((p) =>
    JSON.parse(p),
  );
  if (posts.some((p) => String(p.id) === "1")) {
    return { ok: true, repaired: false, reason: "op-present" };
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
  thread.updatedAt =
    rebuilt[rebuilt.length - 1]?.createdAt || thread.updatedAt;
  await db.set("forum:thread:1", JSON.stringify(thread));
  return { ok: true, repaired: true, posts: rebuilt.length };
}

/**
 * Mod-only forum maintenance hub (Hobby-safe: one serverless function).
 * Actions: repair | diagnose | rebuild-index | reseed
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const actorId = Number(body?.actorId);
  if (
    !Number.isInteger(actorId) ||
    (!FORUM_MOD_IDS.has(actorId) && !canModerateForum(actorId))
  ) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const action = resolveAction(request, body);

  try {
    if (action === "diagnose") {
      return json(await diagnoseForumKeys());
    }
    if (action === "rebuild-index" || action === "rebuild") {
      return json(await rebuildForumIndex());
    }
    if (action === "reseed") {
      return json(await reseedKnownForumThreads());
    }
    // default: legacy thread-1 OP repair
    const result = await repairThread1Op();
    return json(result, result.status || 200);
  } catch (err) {
    console.error("forum repair hub failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
