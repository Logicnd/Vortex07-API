import {
  sessionCookieFrom,
  warmSessionFromBrowser,
} from "../../../lib/identity.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Playvortex-Cookie",
};

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Extension warm-up: seed identity:session cache after the SW verified /me
 * locally. Live PlayVortex /me always wins; browser me is only used when the
 * API host cannot reach PlayVortex (CF / network).
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const cookie = sessionCookieFrom(request, body);
    const result = await warmSessionFromBrowser(cookie, body);
    if (!result.ok) return json(result, result.status || 401);
    return json(result);
  } catch (err) {
    console.error("identity session warm failed", err);
    return json(
      { ok: false, error: "db-error", message: String(err?.message || err) },
      500,
    );
  }
}
