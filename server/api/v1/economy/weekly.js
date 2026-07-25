import { claimWeekly } from "../../../lib/economy.js";
import { isSnowflake, verifyBotHmac } from "../../../lib/economy-auth.js";
import { json, options, readBody } from "../../../lib/economy-http.js";

export function OPTIONS() {
  return options();
}

export async function POST(request) {
  const body = await readBody(request);
  const discordId = String(body?.discordId || "");
  if (!isSnowflake(discordId)) return json({ ok: false, error: "bad-discord-id" }, 400);
  if (!verifyBotHmac(request, { action: "weekly", discordId })) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  try {
    const result = await claimWeekly(discordId);
    return json(result);
  } catch (err) {
    console.error("economy weekly failed", err);
    return json({ ok: false, error: "db-error", message: String(err?.message || err) }, 500);
  }
}
