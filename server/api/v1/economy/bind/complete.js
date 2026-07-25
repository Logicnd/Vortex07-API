import { completeBind } from "../../../../lib/economy.js";
import { parsePlayvortexId } from "../../../../lib/economy-auth.js";
import { json, options, readBody } from "../../../../lib/economy-http.js";

export function OPTIONS() {
  return options();
}

export async function POST(request) {
  const body = await readBody(request);
  const playvortexId = parsePlayvortexId(body?.playvortexId);
  const code = body?.code;
  if (playvortexId === null) return json({ ok: false, error: "bad-playvortex-id" }, 400);
  if (!code) return json({ ok: false, error: "need-code" }, 400);

  try {
    const result = await completeBind(playvortexId, code);
    const status = result.ok ? 200 : 400;
    return json(result, status);
  } catch (err) {
    console.error("economy bind complete failed", err);
    return json({ ok: false, error: "db-error", message: String(err?.message || err) }, 500);
  }
}
