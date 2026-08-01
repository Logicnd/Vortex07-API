import {
  getRatingStatus,
  getUserRatedCount,
  parseActorId,
  parseTargetId,
  parseVote,
  setRating,
} from "../../../lib/ratings.js";
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

function rawTargetFromRequest(request, context) {
  const fromPath = new URL(request.url).pathname.match(
    /\/(?:api\/)?v1\/ratings\/([^/?#]+)\/?$/,
  );
  if (fromPath) return decodeURIComponent(fromPath[1]);

  const params = context?.params;
  if (params && typeof params.then === "function") {
    return null;
  }
  return params?.targetId ?? null;
}

async function resolveRawTarget(request, context) {
  const direct = rawTargetFromRequest(request, context);
  if (direct !== null) return direct;

  try {
    const params = await context?.params;
    return params?.targetId ?? null;
  } catch {
    return null;
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request, context) {
  const raw = await resolveRawTarget(request, context);
  const url = new URL(request.url);

  // GET /v1/ratings/by?userId=123 — distinct games this user has rated
  if (String(raw || "").toLowerCase() === "by") {
    const userId = parseActorId(
      url.searchParams.get("userId") || url.searchParams.get("playvortexId"),
    );
    if (userId === null) return json({ ok: false, error: "bad-user" }, 400);
    try {
      const result = await getUserRatedCount(userId);
      return json(result, result.ok ? 200 : 400);
    } catch (err) {
      console.error("ratings-by-user GET failed", err);
      return json(
        { ok: false, error: "db-error", message: String(err?.message || err) },
        500,
      );
    }
  }

  const targetId = parseTargetId(raw);
  if (targetId === null) return json({ ok: false, error: "bad-target" }, 400);

  // Public counts; myVote only for a verified caller.
  let actorId = null;
  const identity = await resolveWriteIdentity(request, {});
  if (identity.ok) actorId = identity.authorId;

  try {
    const status = await getRatingStatus(targetId, actorId);
    return json({ ok: true, ...status });
  } catch (err) {
    console.error("ratings GET failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function POST(request, context) {
  const raw = await resolveRawTarget(request, context);
  const targetId = parseTargetId(raw);
  if (targetId === null) return json({ ok: false, error: "bad-target" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const url = new URL(request.url);
  const vote = parseVote(
    body?.vote ?? body?.rating ?? url.searchParams.get("vote"),
  );
  if (vote === undefined) {
    return json({ ok: false, error: "bad-vote" }, 400);
  }

  try {
    const identity = await resolveWriteIdentity(request, body);
    if (!identity.ok) return json(identity, identity.status || 401);

    const result = await setRating(targetId, identity.authorId, vote);
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("ratings POST failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
