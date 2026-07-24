import { getLikeStatus, parseUserId, toggleLike } from "../../../lib/likes.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request, context) {
  const targetId = parseUserId(context.params.targetId);
  if (targetId === null) return json({ ok: false, error: "bad-target" }, 400);

  const url = new URL(request.url);
  const actorId = parseUserId(url.searchParams.get("actorId"));

  try {
    const status = await getLikeStatus(targetId, actorId);
    return json({ ok: true, ...status });
  } catch (err) {
    console.error("likes GET failed", err);
    return json({ ok: false, error: "db-missing" }, 500);
  }
}

export async function POST(request, context) {
  const targetId = parseUserId(context.params.targetId);
  if (targetId === null) return json({ ok: false, error: "bad-target" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const url = new URL(request.url);
  const actorId = parseUserId(body?.actorId ?? url.searchParams.get("actorId"));
  if (actorId === null) return json({ ok: false, error: "bad-actor" }, 400);

  try {
    const result = await toggleLike(targetId, actorId);
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("likes POST failed", err);
    return json({ ok: false, error: "db-missing" }, 500);
  }
}
