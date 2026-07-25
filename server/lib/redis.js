/**
 * Single shared Redis client for all Vortex07-API serverless routes.
 * Prevents connection storms when forum/dm/likes/etc each open their own.
 */
import { createClient } from "redis";

/** @type {import('redis').RedisClientType | null} */
let client = null;
/** @type {Promise<import('redis').RedisClientType> | null} */
let connecting = null;

export async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL missing");

  if (client?.isOpen) return client;

  if (!connecting) {
    connecting = (async () => {
      if (!client) {
        client = createClient({ url });
        client.on("error", (err) => console.error("redis error", err));
      }
      if (!client.isOpen) await client.connect();
      return client;
    })().finally(() => {
      connecting = null;
    });
  }

  return connecting;
}

/** Lightweight readiness probe for /health */
export async function pingRedis() {
  try {
    const db = await getRedis();
    const pong = await db.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}
