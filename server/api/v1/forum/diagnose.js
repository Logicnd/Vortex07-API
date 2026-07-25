import { canModerateForum, diagnoseForumKeys } from "../../../lib/forum.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Mod-only read-only scan of forum:* Redis keys. */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const actorId = Number(body?.actorId);
  if (!Number.isInteger(actorId) || !canModerateForum(actorId)) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  try {
    const result = await diagnoseForumKeys();
    return json(result);
  } catch (err) {
    console.error("forum diagnose failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
