import {
  canModerateForum,
  diagnoseForumKeys,
  purgeSpoofedForum,
  rebuildForumIndex,
  reseedKnownForumThreads,
  repairAuthorNames,
} from "../../../lib/forum.js";
import {
  ensureKnownIdentities,
  resolveWriteIdentity,
  scrubJunkIdentityBinds,
} from "../../../lib/identity.js";
import { repairDmThreadNames } from "../../../lib/dm.js";
import { resetProfileLikes, scrubLikeBonuses, scrubSelfLikes } from "../../../lib/likes.js";
import { getRedis } from "../../../lib/redis.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Playvortex-Cookie, X-Vortex07-Proof",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

function resolveAction(request, body) {
  // Body wins — /v1/forum/repair rewrite always stamps ?action=repair.
  if (body?.action) return String(body.action).toLowerCase();
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("action");
  if (fromQuery) return String(fromQuery).toLowerCase();
  const m = url.pathname.match(
    /\/(?:api\/)?v1\/forum\/(diagnose|rebuild-index|reseed|repair|purge-spoof|repair-names|seed-identities|scrub-identities|repair-dm|scrub-like-bonuses|scrub-self-likes|reset-likes)\/?$/i,
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
 * Mod-only maintenance hub (works for every client version — names are
 * resolved server-side).
 *
 * Actions:
 *   repair | diagnose | rebuild-index | reseed | repair-names | purge-spoof
 *   seed-identities | scrub-identities | repair-dm
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const identity = await resolveWriteIdentity(request, body);
  if (!identity.ok) {
    return json(identity, identity.status || 401);
  }
  if (!canModerateForum(identity.authorId)) {
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
    if (action === "seed-identities") {
      const seeded = await ensureKnownIdentities();
      return json({ ok: true, seeded });
    }
    if (action === "scrub-identities" || action === "scrub") {
      const scrubbed = await scrubJunkIdentityBinds();
      const seeded = await ensureKnownIdentities();
      return json({ ...scrubbed, seeded });
    }
    if (action === "repair-dm" || action === "repair-dms") {
      const scrubbed = await scrubJunkIdentityBinds();
      const dm = await repairDmThreadNames();
      return json({ ok: true, scrubbed, dm });
    }
    if (
      action === "scrub-like-bonuses" ||
      action === "scrub-likes-bonus" ||
      action === "scrub-bonuses"
    ) {
      return json(await scrubLikeBonuses());
    }
    if (
      action === "scrub-self-likes" ||
      action === "scrub-selflikes" ||
      action === "purge-self-likes"
    ) {
      return json(await scrubSelfLikes());
    }
    if (action === "reset-likes" || action === "clear-likes") {
      const targetId = Number(body?.targetId);
      return json(await resetProfileLikes(targetId), 200);
    }
    if (
      action === "repair-names" ||
      action === "purge-spoof" ||
      action === "purge"
    ) {
      const scrubbed = await scrubJunkIdentityBinds();
      const seeded = await ensureKnownIdentities();
      const repaired = await repairAuthorNames();
      const dm = await repairDmThreadNames();
      const bonuses = await scrubLikeBonuses();
      return json({ ...repaired, seeded, scrubbed, dm, bonuses });
    }
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
