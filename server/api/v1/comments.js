import {
  addComment,
  deleteComment,
  listComments,
  parseGameId,
} from "../../lib/comments.js";
import {
  sessionCookieFrom,
  writeProofFrom,
} from "../../lib/identity.js";
import { guardRead } from "../../lib/read-guard.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Playvortex-Cookie, X-Vortex07-Proof",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

function resolve(request) {
  const url = new URL(request.url);
  return {
    gameId: parseGameId(url.searchParams.get("gameId")),
    commentId: url.searchParams.get("commentId"),
  };
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request) {
  const { gameId } = resolve(request);
  if (gameId === null) return json({ ok: false, error: "bad-game" }, 400);

  const limited = await guardRead(request, "comments-list", { max: 40 });
  if (limited) return limited;

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit")) || 50;
  const offset = Number(url.searchParams.get("offset")) || 0;

  try {
    const result = await listComments(gameId, limit, offset);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("comments GET failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function POST(request) {
  const { gameId } = resolve(request);
  if (gameId === null) return json({ ok: false, error: "bad-game" }, 400);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const sessionCookie = sessionCookieFrom(request, body);
  const writeProof = writeProofFrom(request, body);
  if (!sessionCookie) {
    return json({ ok: false, error: "session-required" }, 401);
  }

  try {
    const result = await addComment({
      gameId,
      body: body?.body,
      authorId: body?.authorId ?? body?.actorId,
      authorName: body?.authorName,
      sessionCookie,
      writeProof,
    });
    if (!result.ok) return json(result, result.status || 400);
    return json(result, 201);
  } catch (err) {
    console.error("comments POST failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function DELETE(request) {
  const { gameId, commentId } = resolve(request);
  if (gameId === null || !commentId) {
    return json({ ok: false, error: "bad-id" }, 400);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const url = new URL(request.url);
  const actorId =
    body?.actorId ?? body?.authorId ?? url.searchParams.get("actorId");
  const sessionCookie = sessionCookieFrom(request, body);
  const writeProof = writeProofFrom(request, body);

  try {
    const result = await deleteComment({
      gameId,
      commentId,
      actorId,
      sessionCookie,
      writeProof,
    });
    if (!result.ok) return json(result, result.status || 400);
    return json(result);
  } catch (err) {
    console.error("comments DELETE failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
