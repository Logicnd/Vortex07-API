import { claimDaily, claimDailyByPlayvortex } from "../../../lib/economy.js";
import {
  isSnowflake,
  parsePlayvortexId,
  verifyBotHmac,
} from "../../../lib/economy-auth.js";
import { json, options, readBody } from "../../../lib/economy-http.js";

export function OPTIONS() {
  return options();
}

export async function POST(request) {
  const body = await readBody(request);
  const discordId = body?.discordId ? String(body.discordId) : null;
  const playvortexId = parsePlayvortexId(body?.playvortexId);

  try {
    if (discordId && isSnowflake(discordId)) {
      if (!verifyBotHmac(request, { action: "daily", discordId })) {
        return json({ ok: false, error: "forbidden" }, 403);
      }
      const result = await claimDaily(discordId);
      return json(result, result.ok ? 200 : 200);
    }

    if (playvortexId !== null) {
      // Extension path — resolve bind map (no bot HMAC)
      const result = await claimDailyByPlayvortex(playvortexId);
      if (result.error === "not-bound") {
        return json({ ok: false, error: "not-bound" }, 400);
      }
      return json(result);
    }

    return json({ ok: false, error: "need-discord-or-playvortex-id" }, 400);
  } catch (err) {
    console.error("economy daily failed", err);
    return json({ ok: false, error: "db-error", message: String(err?.message || err) }, 500);
  }
}
