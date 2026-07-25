import { ECONOMY_CATALOG } from "../../../lib/economy.js";
import { json, options } from "../../../lib/economy-http.js";

export function OPTIONS() {
  return options();
}

export async function GET() {
  return json({ ok: true, catalog: ECONOMY_CATALOG });
}
