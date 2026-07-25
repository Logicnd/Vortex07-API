import { getMeByPlayvortex } from "../../../lib/economy.js";
import { parsePlayvortexId } from "../../../lib/economy-auth.js";
import { json, options } from "../../../lib/economy-http.js";

export function OPTIONS() {
  return options();
}

export async function GET(request) {
  const url = new URL(request.url);
  const playvortexId = parsePlayvortexId(url.searchParams.get("playvortexId"));
  if (playvortexId === null) return json({ ok: false, error: "bad-playvortex-id" }, 400);

  try {
    const me = await getMeByPlayvortex(playvortexId);
    return json(me);
  } catch (err) {
    console.error("economy me failed", err);
    return json({ ok: false, error: "db-error", message: String(err?.message || err) }, 500);
  }
}
