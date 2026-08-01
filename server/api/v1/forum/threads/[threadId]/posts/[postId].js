import { deletePost, editPost } from "../../../../../../lib/forum.js";
import {
  sessionCookieFrom,
  writeProofFrom,
} from "../../../../../../lib/identity.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Playvortex-Cookie",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

function idsFromRequest(request) {
  const fromPath = new URL(request.url).pathname.match(
    /\/(?:api\/)?v1\/forum\/threads\/([^/]+)\/posts\/([^/]+)\/?$/,
  );
  if (fromPath) {
    return {
      threadId: decodeURIComponent(fromPath[1]),
      postId: decodeURIComponent(fromPath[2]),
    };
  }
  return { threadId: null, postId: null };
}

async function resolveIds(request, context) {
  const direct = idsFromRequest(request);
  if (direct.threadId && direct.postId) return direct;
  try {
    const params = await context?.params;
    return {
      threadId: params?.threadId ? String(params.threadId) : null,
      postId: params?.postId ? String(params.postId) : null,
    };
  } catch {
    return { threadId: null, postId: null };
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function PATCH(request, context) {
  const { threadId, postId } = await resolveIds(request, context);
  if (!threadId || !postId) return json({ ok: false, error: "bad-id" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const url = new URL(request.url);
  const actorId = body?.actorId ?? url.searchParams.get("actorId");

  try {
    const result = await editPost({
      threadId,
      postId,
      actorId,
      body: body?.body,
      title: body?.title,
      sessionCookie: sessionCookieFrom(request, body),
      writeProof: writeProofFrom(request, body),
    });
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("forum edit post failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function DELETE(request, context) {
  const { threadId, postId } = await resolveIds(request, context);
  if (!threadId || !postId) return json({ ok: false, error: "bad-id" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const url = new URL(request.url);
  const actorId = body?.actorId ?? url.searchParams.get("actorId");

  try {
    const result = await deletePost({
      threadId,
      postId,
      actorId,
      sessionCookie: sessionCookieFrom(request, body),
      writeProof: writeProofFrom(request, body),
    });
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("forum delete post failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
