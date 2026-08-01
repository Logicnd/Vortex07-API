import {
  addGroupMembers,
  createGroupChat,
  deleteGroupChat,
  getGroupThread,
  getModThread,
  getThread,
  getUnreadCount,
  kickGroupMember,
  leaveGroupChat,
  listInbox,
  listModLogs,
  listMuted,
  muteUser,
  sendGroupMessage,
  sendMessage,
  sendSystemMessage,
  unmuteUser,
} from "../../../lib/dm.js";
import {
  resolveWriteIdentity,
  timingSafeEqualStr,
  warmSessionFromBrowser,
} from "../../../lib/identity.js";
import { guardRead } from "../../../lib/read-guard.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, X-Playvortex-Cookie, X-Vortex07-Proof, X-Vortex07-System-Secret",
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

function sessionCookieFrom(request) {
  return request.headers.get("x-playvortex-cookie") || "";
}

function writeProofFrom() {
  return "";
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
    groupId: url.searchParams.get("groupId"),
    limit: url.searchParams.get("limit"),
  };
}

/** Private DM/mod reads: identity from cookie/proof only (never query actorId). */
async function requireActor(request) {
  return resolveWriteIdentity(request, {});
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request, context) {
  const { op, peerId, groupId, limit } = await resolveOp(request, context);

  try {
    const identity = await requireActor(request);
    if (!identity.ok) return json(identity, identity.status || 401);
    const actorId = identity.authorId;

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

    if (op === "gc-thread") {
      const limited = await guardRead(request, "dm-gc-thread", {
        actorId,
        max: 40,
      });
      if (limited) return limited;
      const result = await getGroupThread(actorId, groupId);
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "mod-logs") {
      const result = await listModLogs(actorId, limit);
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "mod-thread") {
      const limited = await guardRead(request, "dm-mod-thread", {
        actorId,
        max: 40,
      });
      if (limited) return limited;
      const url = new URL(request.url);
      const result = await getModThread(
        actorId,
        url.searchParams.get("a") ?? url.searchParams.get("userA"),
        url.searchParams.get("b") ?? url.searchParams.get("userB"),
      );
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
  const { op, peerId, groupId } = await resolveOp(request, context);
  const body = await readBody(request);
  const sessionCookie = sessionCookieFrom(request);
  const writeProof = writeProofFrom();

  try {
    // Folded into dm/[op] to stay under Vercel Hobby function limits
    // (a separate /v1/identity/session route blew the deploy).
    if (op === "session-warm") {
      const result = await warmSessionFromBrowser(sessionCookie, body);
      if (!result.ok) return json(result, result.status || 401);
      return json(result);
    }

    if (op === "send") {
      const result = await sendMessage({
        actorId: body?.actorId,
        peerId: peerId ?? body?.peerId,
        authorName: body?.authorName,
        peerName: body?.peerName,
        body: body?.body,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result, 201);
    }

    if (op === "gc-create") {
      const result = await createGroupChat({
        actorId: body?.actorId,
        name: body?.name,
        memberIds: body?.memberIds,
        authorName: body?.authorName,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result, 201);
    }

    if (op === "gc-send") {
      const result = await sendGroupMessage({
        actorId: body?.actorId,
        groupId: groupId ?? body?.groupId,
        authorName: body?.authorName,
        body: body?.body,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result, 201);
    }

    if (op === "gc-kick") {
      const result = await kickGroupMember({
        actorId: body?.actorId,
        groupId: groupId ?? body?.groupId,
        targetId: body?.targetId,
        authorName: body?.authorName,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "gc-add") {
      const result = await addGroupMembers({
        actorId: body?.actorId,
        groupId: groupId ?? body?.groupId,
        memberIds: body?.memberIds,
        authorName: body?.authorName,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "gc-leave") {
      const result = await leaveGroupChat({
        actorId: body?.actorId,
        groupId: groupId ?? body?.groupId,
        authorName: body?.authorName,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "gc-delete") {
      const result = await deleteGroupChat({
        actorId: body?.actorId,
        groupId: groupId ?? body?.groupId,
        authorName: body?.authorName,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "mod-mute") {
      const result = await muteUser({
        actorId: body?.actorId,
        targetId: body?.targetId,
        reason: body?.reason,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "mod-unmute") {
      const result = await unmuteUser({
        actorId: body?.actorId,
        targetId: body?.targetId,
        sessionCookie,
        writeProof,
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result);
    }

    if (op === "system-notify") {
      const expected = String(
        process.env.VORTEX07_SYSTEM_DM_SECRET || "",
      ).trim();
      // Header only — never accept secrets from JSON body.
      const got = String(
        request.headers.get("x-vortex07-system-secret") || "",
      ).trim();
      if (!expected || !timingSafeEqualStr(got, expected)) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
      const result = await sendSystemMessage({
        toUserId: body?.toUserId ?? body?.peerId,
        body: body?.body,
        peerName: body?.peerName || "Vortex07",
      });
      if (!result.ok) return json(result, result.status || 400);
      return json(result, 201);
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
