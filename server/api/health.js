import { pingRedis } from "../lib/redis.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET() {
  const redis = await pingRedis();
  return Response.json(
    {
      ok: true,
      service: "vortex07-api",
      redis,
    },
    { status: redis ? 200 : 503, headers: CORS },
  );
}
