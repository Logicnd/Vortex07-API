import {
  getLikeStatus,
  parseUserId,
  resolveLikeActor,
  toggleLike,
} from "../../../lib/likes.js";
import { resolveWriteIdentity } from "../../../lib/identity.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Playvortex-Cookie, X-Vortex07-Proof",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

function targetIdFromRequest(request, context) {
  const fromPath = new URL(request.url).pathname.match(
    /\/(?:api\/)?v1\/likes\/(\d+)\/?$/,
  );
  if (fromPath) return fromPath[1];

  const params = context?.params;
  if (params && typeof params.then === "function") {
    return null; // resolved below
  }
  return params?.targetId ?? null;
}

async function resolveTargetId(request, context) {
  const direct = targetIdFromRequest(request, context);
  if (direct !== null) return parseUserId(direct);

  try {
    const params = await context?.params;
    return parseUserId(params?.targetId);
  } catch {
    return null;
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request, context) {
  const targetId = await resolveTargetId(request, context);
  if (targetId === null) return json({ ok: false, error: "bad-target" }, 400);

  // Public count is fine; myVote only when the request is authenticated.
  let actorId = null;
  const identity = await resolveWriteIdentity(request, {});
  if (identity.ok) actorId = identity.authorId;

  try {
    const status = await getLikeStatus(targetId, actorId);
    return json({ ok: true, ...status });
  } catch (err) {
    console.error("likes GET failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function POST(request, context) {
  const targetId = await resolveTargetId(request, context);
  if (targetId === null) return json({ ok: false, error: "bad-target" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const resolved = await resolveLikeActor(request, body);
    if (!resolved.ok) {
      return json(resolved, resolved.status || 400);
    }

    const result = await toggleLike(targetId, resolved.actorId, request);
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("likes POST failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
