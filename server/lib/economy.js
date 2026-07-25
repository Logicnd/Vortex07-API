/**
 * Discord-native Vertex Points ledger (Redis).
 * Keys: vp:d:{discordId} · vp:map:pv:{playvortexId} · vp:bind:{CODE}
 */
import { createClient } from "redis";
import { ECONOMY_CATALOG, getCatalogItem } from "./economy-catalog.js";

/** @type {import('redis').RedisClientType | null} */
let client = null;

async function getRedis() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL missing");

  if (!client) {
    client = createClient({ url });
    client.on("error", (err) => console.error("redis error", err));
    await client.connect();
  } else if (!client.isOpen) {
    await client.connect();
  }
  return client;
}

function walletKey(discordId) {
  return `vp:d:${discordId}`;
}

function mapKey(playvortexId) {
  return `vp:map:pv:${playvortexId}`;
}

function bindKey(code) {
  return `vp:bind:${code}`;
}

function emptyWallet(discordId) {
  return {
    discordId: String(discordId),
    bal: 0,
    streak: 0,
    lastDaily: null,
    lastWeekly: null,
    totalEarned: 0,
    owned: [],
    equipped: {},
    playvortexId: null,
    updatedAt: new Date().toISOString(),
  };
}

function utcDayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function utcWeekKey(d = new Date()) {
  // ISO week: YYYY-Www
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function nextUtcMidnightMs(from = new Date()) {
  const n = new Date(from);
  n.setUTCHours(24, 0, 0, 0);
  return n.getTime();
}

function nextUtcWeekMs(from = new Date()) {
  const day = from.getUTCDay() || 7; // Mon=1 … Sun=7
  const daysUntilMon = day === 1 ? 7 : 8 - day;
  const n = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  n.setUTCDate(n.getUTCDate() + daysUntilMon);
  return n.getTime();
}

function dailyReward(streak) {
  const s = Math.max(1, Number(streak) || 1);
  return Math.min(30, 10 + 5 * (s - 1));
}

async function loadWallet(discordId) {
  const db = await getRedis();
  const raw = await db.get(walletKey(discordId));
  if (!raw) return emptyWallet(discordId);
  try {
    const w = JSON.parse(raw);
    return {
      ...emptyWallet(discordId),
      ...w,
      discordId: String(discordId),
      owned: Array.isArray(w.owned) ? w.owned : [],
      equipped: w.equipped && typeof w.equipped === "object" ? w.equipped : {},
    };
  } catch {
    return emptyWallet(discordId);
  }
}

async function saveWallet(wallet) {
  const db = await getRedis();
  wallet.updatedAt = new Date().toISOString();
  await db.set(walletKey(wallet.discordId), JSON.stringify(wallet));
  return wallet;
}

function cosmeticsFromWallet(wallet) {
  const out = {};
  for (const [slot, id] of Object.entries(wallet.equipped || {})) {
    const item = getCatalogItem(id);
    if (item) out[slot] = { id: item.id, name: item.name, frameClass: item.frameClass || null };
  }
  return out;
}

function publicWallet(wallet) {
  const day = utcDayKey();
  const week = utcWeekKey();
  return {
    ok: true,
    discordId: wallet.discordId,
    balance: wallet.bal,
    streak: wallet.streak,
    totalEarned: wallet.totalEarned,
    owned: wallet.owned,
    equipped: wallet.equipped,
    cosmetics: cosmeticsFromWallet(wallet),
    playvortexId: wallet.playvortexId || null,
    canClaimDaily: wallet.lastDaily !== day,
    earn: {
      canClaimWeekly: wallet.lastWeekly !== week,
      nextDailyReward: dailyReward(
        wallet.lastDaily === day ? wallet.streak : Math.max(1, (wallet.streak || 0) + 1),
      ),
    },
    nextClaimAt: wallet.lastDaily === day ? nextUtcMidnightMs() : null,
    nextWeeklyAt: wallet.lastWeekly === week ? nextUtcWeekMs() : null,
    catalog: ECONOMY_CATALOG,
  };
}

export async function getWallet(discordId, { grantVortality = false } = {}) {
  let wallet = await loadWallet(discordId);
  if (grantVortality && !wallet.owned.includes("vortality")) {
    wallet.owned = [...wallet.owned, "vortality"];
    await saveWallet(wallet);
  }
  return publicWallet(wallet);
}

export async function claimDaily(discordId, { grantVortality = true } = {}) {
  let wallet = await loadWallet(discordId);
  if (grantVortality && !wallet.owned.includes("vortality")) {
    wallet.owned = [...wallet.owned, "vortality"];
  }

  const day = utcDayKey();
  if (wallet.lastDaily === day) {
    return {
      ok: false,
      error: "already-claimed",
      balance: wallet.bal,
      streak: wallet.streak,
      nextClaimAt: nextUtcMidnightMs(),
    };
  }

  const yesterday = utcDayKey(new Date(Date.now() - 86400000));
  const streak = wallet.lastDaily === yesterday ? (wallet.streak || 0) + 1 : 1;
  const reward = dailyReward(streak);

  wallet.streak = streak;
  wallet.lastDaily = day;
  wallet.bal += reward;
  wallet.totalEarned += reward;
  await saveWallet(wallet);

  return {
    ok: true,
    reward,
    streakBonus: streak > 1 ? Math.min(20, 5 * (streak - 1)) : 0,
    balance: wallet.bal,
    streak: wallet.streak,
    nextDailyReward: dailyReward(streak + 1),
    nextClaimAt: nextUtcMidnightMs(),
  };
}

export async function claimWeekly(discordId, { grantVortality = true } = {}) {
  let wallet = await loadWallet(discordId);
  if (grantVortality && !wallet.owned.includes("vortality")) {
    wallet.owned = [...wallet.owned, "vortality"];
  }

  const week = utcWeekKey();
  if (wallet.lastWeekly === week) {
    return {
      ok: false,
      error: "already-claimed",
      balance: wallet.bal,
      nextWeeklyAt: nextUtcWeekMs(),
    };
  }

  const reward = 25;
  wallet.lastWeekly = week;
  wallet.bal += reward;
  wallet.totalEarned += reward;
  await saveWallet(wallet);

  return {
    ok: true,
    reward,
    balance: wallet.bal,
    nextWeeklyAt: nextUtcWeekMs(),
  };
}

export async function buyItem(discordId, itemId, { haveRep = 0 } = {}) {
  const item = getCatalogItem(itemId);
  if (!item) return { ok: false, error: "unknown-item" };
  if (item.grantOnly) return { ok: false, error: "grant-only" };

  let wallet = await loadWallet(discordId);
  if (wallet.owned.includes(item.id)) return { ok: false, error: "already-owned" };

  const needRep = Number(item.requireRep) || 0;
  if (needRep > 0 && Number(haveRep) < needRep) {
    return { ok: false, error: "insufficient-rep", requireRep: needRep, haveRep: Number(haveRep) || 0 };
  }

  const cost = Number(item.cost) || 0;
  if (wallet.bal < cost) return { ok: false, error: "insufficient-balance" };

  wallet.bal -= cost;
  wallet.owned = [...wallet.owned, item.id];
  await saveWallet(wallet);

  return { ok: true, spent: cost, balance: wallet.bal, itemId: item.id };
}

export async function equipItem(discordId, itemId) {
  const item = getCatalogItem(itemId);
  if (!item) return { ok: false, error: "unknown-item" };

  let wallet = await loadWallet(discordId);
  if (!wallet.owned.includes(item.id)) return { ok: false, error: "not-owned" };

  wallet.equipped = { ...wallet.equipped, [item.slot]: item.id };
  await saveWallet(wallet);

  return {
    ok: true,
    slot: item.slot,
    itemId: item.id,
    cosmetics: cosmeticsFromWallet(wallet),
    balance: wallet.bal,
  };
}

function makeBindCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export async function startBind(discordId) {
  const db = await getRedis();
  const code = makeBindCode();
  const ttlSec = 15 * 60;
  await db.set(bindKey(code), String(discordId), { EX: ttlSec });
  return { ok: true, code, expiresInSec: ttlSec };
}

export async function completeBind(playvortexId, code) {
  const db = await getRedis();
  const cleaned = String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (cleaned.length < 6) return { ok: false, error: "bad-code" };

  const discordId = await db.get(bindKey(cleaned));
  if (!discordId) return { ok: false, error: "invalid-or-expired" };

  await db.set(mapKey(playvortexId), String(discordId));
  await db.del(bindKey(cleaned));

  let wallet = await loadWallet(discordId);
  wallet.playvortexId = Number(playvortexId);
  if (!wallet.owned.includes("vortality")) {
    wallet.owned = [...wallet.owned, "vortality"];
  }
  await saveWallet(wallet);

  return { ok: true, discordId, playvortexId: Number(playvortexId), balance: wallet.bal };
}

export async function resolveDiscordId(playvortexId) {
  const db = await getRedis();
  const discordId = await db.get(mapKey(playvortexId));
  return discordId || null;
}

export async function getMeByPlayvortex(playvortexId) {
  const discordId = await resolveDiscordId(playvortexId);
  if (!discordId) {
    return { ok: true, bound: false, playvortexId: Number(playvortexId) };
  }
  const wallet = await getWallet(discordId);
  return { ok: true, bound: true, playvortexId: Number(playvortexId), ...wallet };
}

export async function claimDailyByPlayvortex(playvortexId) {
  const discordId = await resolveDiscordId(playvortexId);
  if (!discordId) return { ok: false, error: "not-bound" };
  return claimDaily(discordId);
}

export { ECONOMY_CATALOG };
