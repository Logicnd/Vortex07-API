import { createThread, listThreads } from "../../../../lib/forum.js";
import { guardRead } from "../../../../lib/read-guard.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Playvortex-Cookie",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request) {
  const limited = await guardRead(request, "forum-list", { max: 40 });
  if (limited) return limited;

  const url = new URL(request.url);
  const categoryId = url.searchParams.get("category") || "general";
  const limit = Number(url.searchParams.get("limit") || 30);
  const offset = Number(url.searchParams.get("offset") || 0);
  try {
    const result = await listThreads(categoryId, limit, offset);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("forum list failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await createThread({
      categoryId: body.categoryId,
      title: body.title,
      body: body.body,
      authorId: body.authorId,
      authorName: body.authorName,
      sessionCookie:
        body.sessionCookie ||
        request.headers.get("x-playvortex-cookie") ||
        "",
    });
    if (!result.ok) return json(result, result.status || 400);
    return json(result, 201);
  } catch (err) {
    console.error("forum create failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
