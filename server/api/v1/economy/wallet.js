import { getWallet } from "../../../lib/economy.js";
import { isSnowflake, verifyBotHmac } from "../../../lib/economy-auth.js";
import { json, options } from "../../../lib/economy-http.js";

export function OPTIONS() {
  return options();
}

export async function GET(request) {
  const url = new URL(request.url);
  const discordId = url.searchParams.get("discordId");
  if (!isSnowflake(discordId)) return json({ ok: false, error: "bad-discord-id" }, 400);
  if (!verifyBotHmac(request, { action: "wallet", discordId })) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const grant = url.searchParams.get("grantVortality") === "1";
  try {
    const wallet = await getWallet(discordId, { grantVortality: grant });
    return json(wallet);
  } catch (err) {
    console.error("economy wallet failed", err);
    return json({ ok: false, error: "db-error", message: String(err?.message || err) }, 500);
  }
}
