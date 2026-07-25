import { buyItem } from "../../../lib/economy.js";
import { isSnowflake, verifyBotHmac } from "../../../lib/economy-auth.js";
import { json, options, readBody } from "../../../lib/economy-http.js";

export function OPTIONS() {
  return options();
}

export async function POST(request) {
  const body = await readBody(request);
  const discordId = String(body?.discordId || "");
  const itemId = String(body?.itemId || "").toLowerCase();
  if (!isSnowflake(discordId)) return json({ ok: false, error: "bad-discord-id" }, 400);
  if (!itemId) return json({ ok: false, error: "need-item" }, 400);
  if (!verifyBotHmac(request, { action: "buy", discordId })) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  try {
    const result = await buyItem(discordId, itemId, {
      haveRep: Number(body?.haveRep) || 0,
    });
    return json(result);
  } catch (err) {
    console.error("economy buy failed", err);
    return json({ ok: false, error: "db-error", message: String(err?.message || err) }, 500);
  }
}
