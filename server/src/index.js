/**
 * Vortex07 API — Cloudflare Worker + D1
 *
 * GET  /health
 * GET  /v1/likes/:targetId?actorId=123
 * POST /v1/likes/:targetId  JSON { "actorId": 123 }  (toggle)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function parseUserId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function matchLikesRoute(pathname) {
  const match = pathname.match(/^\/v1\/likes\/(\d+)\/?$/);
  return match ? match[1] : null;
}

async function getLikeStatus(db, targetId, actorId) {
  const countRow = await db
    .prepare("SELECT COUNT(*) AS count FROM likes WHERE target_id = ?")
    .bind(targetId)
    .first();

  let liked = false;
  if (actorId !== null) {
    const vote = await db
      .prepare(
        "SELECT 1 AS ok FROM likes WHERE actor_id = ? AND target_id = ? LIMIT 1",
      )
      .bind(actorId, targetId)
      .first();
    liked = Boolean(vote);
  }

  return {
    targetId,
    count: Number(countRow?.count) || 0,
    liked,
    myVote: liked ? "up" : null,
  };
}

async function toggleLike(db, targetId, actorId) {
  if (actorId === targetId) {
    return { ok: false, reason: "self", status: 400 };
  }

  const existing = await db
    .prepare(
      "SELECT 1 AS ok FROM likes WHERE actor_id = ? AND target_id = ? LIMIT 1",
    )
    .bind(actorId, targetId)
    .first();

  if (existing) {
    await db
      .prepare("DELETE FROM likes WHERE actor_id = ? AND target_id = ?")
      .bind(actorId, targetId)
      .run();
  } else {
    await db
      .prepare("INSERT INTO likes (actor_id, target_id) VALUES (?, ?)")
      .bind(actorId, targetId)
      .run();
  }

  const status = await getLikeStatus(db, targetId, actorId);
  return { ok: true, ...status };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/health" || path === "/")) {
      return json({ ok: true, service: "vortex07-api" });
    }

    const targetRaw = matchLikesRoute(path);
    if (targetRaw) {
      const targetId = parseUserId(targetRaw);
      if (targetId === null) {
        return json({ ok: false, error: "bad-target" }, 400);
      }

      if (!env.DB) {
        return json({ ok: false, error: "db-missing" }, 500);
      }

      if (request.method === "GET") {
        const actorId = parseUserId(url.searchParams.get("actorId"));
        const status = await getLikeStatus(env.DB, targetId, actorId);
        return json({ ok: true, ...status });
      }

      if (request.method === "POST") {
        let body = {};
        try {
          body = await request.json();
        } catch {
          body = {};
        }

        const actorId = parseUserId(body?.actorId ?? url.searchParams.get("actorId"));
        if (actorId === null) {
          return json({ ok: false, error: "bad-actor" }, 400);
        }

        const result = await toggleLike(env.DB, targetId, actorId);
        if (!result.ok) {
          return json(result, result.status || 400);
        }
        return json(result);
      }

      return json({ ok: false, error: "method-not-allowed" }, 405);
    }

    return json({ ok: false, error: "not-found" }, 404);
  },
};
