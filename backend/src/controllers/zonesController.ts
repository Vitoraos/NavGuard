// src/controllers/zonesController.ts
// POST /api/zones — compute initial zones, create monitor session
// GET /api/zones/stream/:sessionId — SSE stream for live updates

import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../config/db.js";
import { computeZones, DroneThresholds, BBox } from "../services/zoneEngine.js";
import { createSession, registerClient } from "../services/monitorService.js";

export async function zonesHandler(req: Request, res: Response) {
  try {
    const { bbox, thresholds } = req.body;
    if (!bbox || typeof bbox.minLat !== "number" || typeof bbox.maxLat !== "number" || typeof bbox.minLon !== "number" || typeof bbox.maxLon !== "number") {
      return res.status(400).json({ error: "bbox is required: { minLat, maxLat, minLon, maxLon }" });
    }
    const t: DroneThresholds = { max_wind_mph: thresholds?.max_wind_mph ?? 25, max_precip: thresholds?.max_precip ?? 2, min_visibility: thresholds?.min_visibility ?? 1000 };
    const b: BBox = { minLat: bbox.minLat, maxLat: bbox.maxLat, minLon: bbox.minLon, maxLon: bbox.maxLon };
    const result = await computeZones(b, t);
    const sessionId = uuidv4();
    await pool.query(`INSERT INTO weather_monitor_sessions (id, bbox, thresholds) VALUES ($1, $2, $3)`, [sessionId, JSON.stringify(b), JSON.stringify(t)]);
    await createSession(sessionId, b, t);
    return res.status(200).json({ session_id: sessionId, stream_url: `/api/zones/stream/${sessionId}`, safe_airspace: result.safe_airspace, no_fly_zones: result.no_fly_zones, violated_points: result.violated_points, thresholds: t, bbox: b, computed_at: new Date().toISOString() });
  } catch (err: any) {
    console.error("[zones] Handler error:", err);
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
}

export async function zonesStreamHandler(req: Request, res: Response) {
  const { sessionId } = req.params;
  let sessionRow: any;
  try {
    const { rows } = await pool.query(`SELECT id, bbox, thresholds, last_snapshot FROM weather_monitor_sessions WHERE id = $1 AND expires_at > NOW()`, [sessionId]);
    if (!rows.length) return res.status(404).json({ error: "Session not found or expired. Call POST /api/zones to start a new session." });
    sessionRow = rows[0];
  } catch (err: any) { return res.status(500).json({ error: err.message }); }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  if (sessionRow.last_snapshot) {
    res.write(`data: ${JSON.stringify({ ...sessionRow.last_snapshot, type: "reconnect_snapshot" })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ type: "connected", session_id: sessionId })}\n\n`);
  }

  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(ping); } }, 30_000);
  res.on("close", () => clearInterval(ping));

  const registered = registerClient(sessionId, res);
  if (!registered) {
    const bbox: BBox = sessionRow.bbox;
    const thresholds: DroneThresholds = sessionRow.thresholds;
    await createSession(sessionId, bbox, thresholds);
    registerClient(sessionId, res);
  }
}