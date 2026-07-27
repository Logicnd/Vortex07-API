import { replyToThread } from "../../../../../lib/forum.js";
import {
  sessionCookieFrom,
  writeProofFrom,
} from "../../../../../lib/identity.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Playvortex-Cookie, X-Vortex07-Proof",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

function threadIdFromRequest(request) {
  const fromPath = new URL(request.url).pathname.match(
    /\/(?:api\/)?v1\/forum\/threads\/([^/]+)\/posts\/?$/,
  );
  if (fromPath) return decodeURIComponent(fromPath[1]);
  return null;
}

async function resolveThreadId(request, context) {
  const direct = threadIdFromRequest(request);
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

export async function POST(request, context) {
  const threadId = await resolveThreadId(request, context);
  if (!threadId) return json({ ok: false, error: "bad-id" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await replyToThread({
      threadId,
      body: body.body,
      authorId: body.authorId,
      authorName: body.authorName,
      sessionCookie: sessionCookieFrom(request, body),
      writeProof: writeProofFrom(request, body),
    });
    if (!result.ok) return json(result, result.status || 400);
    return json(result, 201);
  } catch (err) {
    console.error("forum reply failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
