import { deleteThread, getThread } from "../../../../lib/forum.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

function threadIdFromRequest(request, context) {
  const fromPath = new URL(request.url).pathname.match(
    /\/(?:api\/)?v1\/forum\/threads\/([^/]+)\/?$/,
  );
  if (fromPath) return decodeURIComponent(fromPath[1]);
  return null;
}

async function resolveThreadId(request, context) {
  const direct = threadIdFromRequest(request, context);
  if (direct) return direct;
  try {
    const params = await context?.params;
    return params?.threadId ? String(params.threadId) : null;
  } catch {
    return null;
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request, context) {
  const threadId = await resolveThreadId(request, context);
  if (!threadId) return json({ ok: false, error: "bad-id" }, 400);

  try {
    const result = await getThread(threadId);
    if (!result) return json({ ok: false, error: "not-found" }, 404);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("forum get failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function DELETE(request, context) {
  const threadId = await resolveThreadId(request, context);
  if (!threadId) return json({ ok: false, error: "bad-id" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const url = new URL(request.url);
  const actorId = body?.actorId ?? url.searchParams.get("actorId");

  try {
    const result = await deleteThread({ threadId, actorId });
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("forum delete thread failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
