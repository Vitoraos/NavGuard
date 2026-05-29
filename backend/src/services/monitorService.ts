import { Response } from "express";
import { pool } from "../config/db";
import { computeZones, DroneThresholds, BBox } from "./zoneEngine";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface MonitorSession {
  id:              string;
  bbox:            BBox;
  thresholds:      DroneThresholds;
  clients:         Set<Response>;
  lastViolatedIds: Set<number>;
  timer:           NodeJS.Timeout | null;
}

const sessions = new Map<string, MonitorSession>();

export async function createSession(
  sessionId:  string,
  bbox:       BBox,
  thresholds: DroneThresholds
): Promise<void> {
  if (sessions.has(sessionId)) return;

  const session: MonitorSession = {
    id: sessionId, bbox, thresholds,
    clients:         new Set(),
    lastViolatedIds: new Set(),
    timer:           null,
  };

  sessions.set(sessionId, session);
  startPolling(session);
  console.log(`[monitor] Session created: ${sessionId}`);
}

export function registerClient(sessionId: string, res: Response): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.clients.add(res);
  console.log(`[monitor] Client connected — session: ${sessionId}, clients: ${session.clients.size}`);

  res.on("close", () => {
    session.clients.delete(res);
    console.log(`[monitor] Client disconnected — session: ${sessionId}`);
  });

  return true;
}

export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  sessions.delete(sessionId);
}

export function getSession(sessionId: string): MonitorSession | undefined {
  return sessions.get(sessionId);
}

export function broadcast(session: MonitorSession, data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of session.clients) {
    try { client.write(payload); }
    catch { session.clients.delete(client); }
  }
}

function startPolling(session: MonitorSession): void {
  // FIX-08: timer assigned BEFORE first poll
  session.timer = setInterval(() => runPoll(session), POLL_INTERVAL_MS);
  runPoll(session);
}

async function runPoll(session: MonitorSession): Promise<void> {
  if (session.clients.size === 0) return;

  try {
    const result         = await computeZones(session.bbox, session.thresholds);
    const newViolatedIds = new Set(result.violated_points.map(v => v.id));
    const newViolations  = result.violated_points.filter(v => !session.lastViolatedIds.has(v.id));
    const recoveredIds   = [...session.lastViolatedIds].filter(id => !newViolatedIds.has(id));

    session.lastViolatedIds = newViolatedIds;

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

    broadcast(session, event);

    await pool.query(
      `UPDATE weather_monitor_sessions SET last_snapshot = $1 WHERE id = $2`,
      [JSON.stringify(event), session.id]
    );

    if (event.alert)
      console.log(`[monitor] ALERT — session ${session.id}: ${newViolations.length} new violation(s)`);

  } catch (err) {
    console.error(`[monitor] Poll error — session ${session.id}:`, err);
  }
}
