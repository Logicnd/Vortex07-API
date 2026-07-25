import {
  getThread,
  getUnreadCount,
  listInbox,
  listModLogs,
  listMuted,
  muteUser,
  sendMessage,
  unmuteUser,
} from "../../../lib/dm.js";
import { guardRead } from "../../../lib/read-guard.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function resolveOp(request, context) {
  const url = new URL(request.url);
  let op = url.searchParams.get("op");
  if (!op) {
    const m = url.pathname.match(/\/(?:api\/)?v1\/dm\/([^/?#]+)/i);
    if (m) op = decodeURIComponent(m[1]);
  }
  if (!op) {
    try {
      const params = await context?.params;
      if (params?.op) op = String(params.op);
    } catch {
      /* ignore */
    }
  }
  return {
    op: op || null,
    peerId: url.searchParams.get("peerId"),
    actorId: url.searchParams.get("actorId"),
    limit: url.searchParams.get("limit"),
  };
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request, context) {
  const { op, peerId, actorId, limit } = await resolveOp(request, context);

  try {
    if (op === "inbox") {
      const limited = await guardRead(request, "dm-inbox", {
        actorId,
        max: 30,
      });
      if (limited) return limited;
      const result = await listInbox(actorId);
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "unread") {
      const limited = await guardRead(request, "dm-unread", {
        actorId,
        max: 30,
      });
      if (limited) return limited;
      const result = await getUnreadCount(actorId);
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "thread") {
      const limited = await guardRead(request, "dm-thread", {
        actorId,
        max: 40,
      });
      if (limited) return limited;
      const result = await getThread(actorId, peerId);
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "mod-logs") {
      const result = await listModLogs(actorId, limit);
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "mod-muted") {
      const result = await listMuted(actorId);
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    return json({ ok: false, error: "not-found", op }, 404);
  } catch (err) {
    console.error("dm GET failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}

export async function POST(request, context) {
  const { op, peerId } = await resolveOp(request, context);
  const body = await readBody(request);

  try {
    if (op === "send") {
      const result = await sendMessage({
        actorId: body?.actorId,
        peerId: peerId ?? body?.peerId,
        authorName: body?.authorName,
        peerName: body?.peerName,
        body: body?.body,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result, 201);
    }

    if (op === "mod-mute") {
      const result = await muteUser({
        actorId: body?.actorId,
        targetId: body?.targetId,
        reason: body?.reason,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "mod-unmute") {
      const result = await unmuteUser({
        actorId: body?.actorId,
        targetId: body?.targetId,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    return json({ ok: false, error: "not-found", op }, 404);
  } catch (err) {
    console.error("dm POST failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
