// src/services/monitorService.ts
// Redis-backed SSE monitor service.
//
// Architecture:
//   - Session metadata (bbox, thresholds, last_snapshot) stored in Redis hashes
//     with TTL matching the DB expires_at. Survives server restarts.
//   - Broadcasts go through Redis Pub/Sub channel "session:{id}".
//     Any instance that has subscribers for that session will forward to them.
//   - Polling is protected by a Redis lock "lock:poll:{id}".
//     Only one instance polls per session at a time — safe for any number of instances.
//   - In-memory client sets (Set<Response>) are local to each instance.
//     They are registered/removed on SSE connect/disconnect as before.
//     No in-memory state is authoritative — Redis is the source of truth.

import { Response } from "express";
import { redis, redisSub } from "../config/redis";
import { pool } from "../config/db";
import { computeZones, DroneThresholds, BBox } from "./zoneEngine";

const POLL_INTERVAL_MS  = 5 * 60 * 1000;
const LOCK_TTL_S        = 60;           // poll lock expires after 60s even if instance dies
const SESSION_TTL_S     = 12 * 60 * 60; // 12 hours, matches DB expires_at

// Local client registry — per instance only
const localClients = new Map<string, Set<Response>>();

// ─── Redis key helpers ──────────────────────────────────────────────────────
const keyMeta   = (id: string) => `session:meta:${id}`;
const keySnap   = (id: string) => `session:snap:${id}`;
const keyLock   = (id: string) => `lock:poll:${id}`;
const keyChan   = (id: string) => `session:${id}`;
const keyViolated = (id: string) => `session:violated:${id}`;

// ─── Session metadata ───────────────────────────────────────────────────────
export async function createSession(
  sessionId:  string,
  bbox:       BBox,
  thresholds: DroneThresholds
): Promise<void> {
  const exists = await redis.exists(keyMeta(sessionId));
  if (exists) return;

  await redis.hset(keyMeta(sessionId), {
    bbox:       JSON.stringify(bbox),
    thresholds: JSON.stringify(thresholds),
    created_at: new Date().toISOString(),
  });
  await redis.expire(keyMeta(sessionId), SESSION_TTL_S);

  console.log(`[monitor] Session created in Redis: ${sessionId}`);
  startPolling(sessionId);
}

export async function getSession(sessionId: string): Promise<{ id: string; bbox: BBox; thresholds: DroneThresholds } | null> {
  const meta = await redis.hgetall(keyMeta(sessionId));
  if (!meta?.bbox) return null;
  return {
    id:         sessionId,
    bbox:       JSON.parse(meta.bbox),
    thresholds: JSON.parse(meta.thresholds),
  };
}

export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(keyMeta(sessionId), keySnap(sessionId), keyLock(sessionId), keyViolated(sessionId));
  localClients.delete(sessionId);
  console.log(`[monitor] Session destroyed: ${sessionId}`);
}

// ─── Local SSE client registration ─────────────────────────────────────────
export function registerClient(sessionId: string, res: Response): boolean {
  // We register locally and subscribe to the Redis channel for this session
  // so broadcasts from any instance reach this client
  if (!localClients.has(sessionId)) {
    localClients.set(sessionId, new Set());
    // Subscribe once per session per instance
    redisSub.subscribe(keyChan(sessionId), (err) => {
      if (err) console.error(`[monitor] Redis subscribe error for ${sessionId}:`, err);
      else console.log(`[monitor] Subscribed to Redis channel: ${keyChan(sessionId)}`);
    });
  }

  const clients = localClients.get(sessionId)!;
  clients.add(res);
  console.log(`[monitor] Client connected — session: ${sessionId}, local clients: ${clients.size}`);

  res.on("close", () => {
    clients.delete(res);
    console.log(`[monitor] Client disconnected — session: ${sessionId}, local clients: ${clients.size}`);

    // If no more local clients for this session, unsubscribe from Redis channel
    if (clients.size === 0) {
      localClients.delete(sessionId);
      redisSub.unsubscribe(keyChan(sessionId));
    }
  });

  return true;
}

// ─── Redis Pub/Sub message handler ─────────────────────────────────────────
// All SSE fan-out happens here — one place, all instances
redisSub.on("message", (channel: string, message: string) => {
  // Extract sessionId from channel name "session:{id}"
  const sessionId = channel.replace("session:", "");
  const clients   = localClients.get(sessionId);
  if (!clients || clients.size === 0) return;

  const payload = `data: ${message}\n\n`;
  for (const client of clients) {
    try { client.write(payload); }
    catch { clients.delete(client); }
  }
});

// ─── Broadcast ──────────────────────────────────────────────────────────────
// Publishes to Redis — reaches every instance subscribed to this session
export async function broadcast(
  sessionOrId: { id: string } | string,
  data: object
): Promise<void> {
  const sessionId = typeof sessionOrId === "string" ? sessionOrId : sessionOrId.id;
  const payload   = JSON.stringify(data);
  await redis.publish(keyChan(sessionId), payload);
}

// ─── Snapshot (last_snapshot for reconnecting clients) ─────────────────────
async function saveSnapshot(sessionId: string, event: object): Promise<void> {
  await redis.set(keySnap(sessionId), JSON.stringify(event), "EX", SESSION_TTL_S);
  // Also persist to DB for durability across full Redis restarts
  await pool.query(
    `UPDATE weather_monitor_sessions SET last_snapshot = $1 WHERE id = $2`,
    [JSON.stringify(event), sessionId]
  );
}

export async function getSnapshot(sessionId: string): Promise<object | null> {
  const snap = await redis.get(keySnap(sessionId));
  if (snap) return JSON.parse(snap);
  // Fallback to DB if Redis snapshot was evicted
  const { rows } = await pool.query(
    `SELECT last_snapshot FROM weather_monitor_sessions WHERE id = $1`,
    [sessionId]
  );
  return rows[0]?.last_snapshot ?? null;
}

// ─── Distributed poll lock ──────────────────────────────────────────────────
// SET NX EX — only one instance wins the lock per poll interval
async function acquirePollLock(sessionId: string): Promise<boolean> {
  const result = await redis.set(keyLock(sessionId), "1", "NX", "EX", LOCK_TTL_S);
  return result === "OK";
}

// ─── Polling ────────────────────────────────────────────────────────────────
function startPolling(sessionId: string): void {
  const timer = setInterval(async () => {
    await runPoll(sessionId);
  }, POLL_INTERVAL_MS);

  // Unref so the timer doesn't keep the process alive after all else is done
  timer.unref();

  // Run first poll immediately
  setImmediate(() => runPoll(sessionId));
}

async function runPoll(sessionId: string): Promise<void> {
  // Only poll if there are local clients — saves compute when no one is watching
  const clients = localClients.get(sessionId);
  if (!clients || clients.size === 0) return;

  // Distributed lock — skip if another instance is already polling this session
  const locked = await acquirePollLock(sessionId);
  if (!locked) return;

  try {
    const meta = await redis.hgetall(keyMeta(sessionId));
    if (!meta?.bbox) return;

    const bbox:       BBox           = JSON.parse(meta.bbox);
    const thresholds: DroneThresholds = JSON.parse(meta.thresholds);

    const result = await computeZones(bbox, thresholds);

    // Diff against last violated set stored in Redis
    const prevRaw      = await redis.smembers(keyViolated(sessionId));
    const prevViolated = new Set(prevRaw.map(Number));
    const newViolated  = new Set(result.violated_points.map(v => v.id));

    const newViolations = result.violated_points.filter(v => !prevViolated.has(v.id));
    const recoveredIds  = [...prevViolated].filter(id => !newViolated.has(id));

    // Update violated set in Redis
    await redis.del(keyViolated(sessionId));
    if (newViolated.size > 0) {
      await redis.sadd(keyViolated(sessionId), ...[...newViolated].map(String));
      await redis.expire(keyViolated(sessionId), SESSION_TTL_S);
    }

    const event = {
      type:            "zone_update",
      timestamp:       new Date().toISOString(),
      alert:           newViolations.length > 0,
      new_violations:  newViolations,
      recovered_ids:   recoveredIds,
      safe_airspace:   result.safe_airspace,
      no_fly_zones:    result.no_fly_zones,
      violated_points: result.violated_points,
    };

    await broadcast(sessionId, event);
    await saveSnapshot(sessionId, event);

    if (event.alert) {
      console.log(`[monitor] ALERT — session ${sessionId}: ${newViolations.length} new violation(s)`);
    }

  } catch (err) {
    console.error(`[monitor] Poll error — session ${sessionId}:`, err);
  }
  // Lock expires naturally via TTL — no need to delete it
}
