// src/controllers/zonesController.ts
import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../config/db";
import { computeZones, DroneThresholds, BBox } from "../services/zoneEngine";
import { auditLog } from "../services/auditService";
import { createSession, registerClient, getSession, getSnapshot, SessionAltitude } from "../services/monitorService";

export async function zonesHandler(req: Request, res: Response) {
  try {
    const { bbox, thresholds, altitude_floor, altitude_ceiling } = req.body;
    const apiKeyId = (req as any).apiKeyId;

    if (!bbox || typeof bbox.minLat !== "number" || typeof bbox.maxLat !== "number" || typeof bbox.minLon !== "number" || typeof bbox.maxLon !== "number") {
      return res.status(400).json({ error: "bbox is required: { minLat, maxLat, minLon, maxLon }" });
    }

    const t: DroneThresholds = {
      max_wind_mph:   thresholds?.max_wind_mph   ?? 25,
      max_gust_mph:   thresholds?.max_gust_mph   ?? 35, // FIX-GUST
      max_precip:     thresholds?.max_precip     ?? 2,
      min_visibility: thresholds?.min_visibility ?? 1000,
    };
    const b: BBox = {
      minLat: bbox.minLat, maxLat: bbox.maxLat,
      minLon: bbox.minLon, maxLon: bbox.maxLon,
    };
    // FIX-3D-VOLUME: altitude range is now a real input to this endpoint —
    // previously there was no altitude concept here at all and computeZones
    // silently always ran against the surface band only.
    const altitude: SessionAltitude = {
      floor:   Number(altitude_floor   ?? 0),
      ceiling: Number(altitude_ceiling ?? 400),
    };
    if (!Number.isFinite(altitude.floor) || !Number.isFinite(altitude.ceiling) || altitude.floor < 0 || altitude.ceiling > 10000 || altitude.floor > altitude.ceiling) {
      return res.status(400).json({ error: "Invalid altitude_floor/altitude_ceiling" });
    }

    const result = await computeZones(b, t, altitude.floor, altitude.ceiling);

    // FIX-NFZ-STALE: refuse to start a routing session against airspace data
    // that's already known to be stale — same posture /scan already takes
    // (503 airspace_data_stale) when its TFR data is too old. A client
    // shouldn't be handed a session_id and a stream_url for a volume that's
    // untrustworthy from the very first computation.
    if (result.nfz_stale) {
      return res.status(503).json({
        error:       "airspace_data_stale",
        last_synced: result.nfz_last_synced,
        message:     "NFZ/TFR data is older than 15 minutes. Do not start a routing session against this volume.",
      });
    }

    const sessionId = uuidv4();

    await pool.query(
      `INSERT INTO weather_monitor_sessions (id, bbox, thresholds, altitude_floor, altitude_ceiling) VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, JSON.stringify(b), JSON.stringify(t), altitude.floor, altitude.ceiling]
    );
    await createSession(sessionId, b, t, altitude);

    const successResponse = {
      session_id:      sessionId,
      stream_url:      `/api/zones/stream/${sessionId}`,
      safe_airspace:   result.safe_airspace,
      no_fly_zones:    result.no_fly_zones,
      violated_points: result.violated_points,
      altitude_band:   result.altitude_band,
      nfz_last_synced: result.nfz_last_synced, // NEW — lets the client judge freshness even on a fresh (non-stale) response
      thresholds:      t,
      bbox:            b,
      altitude,
      computed_at:     new Date().toISOString(),
    };

    auditLog({
      endpoint: "POST /zones",
      apiKeyId,
      summary: {
        session_id:          sessionId,
        bbox:                b,
        altitude,
        altitude_band:       result.altitude_band,
        violated_point_count: result.violated_points.length,
        no_fly_zone_count:   result.no_fly_zones.length,
        safe_airspace:       result.safe_airspace,
        computed_at:         successResponse.computed_at,
      },
      fullResponse: successResponse,
    });

    return res.status(200).json(successResponse);

  } catch (err: any) {
    console.error("[zones] Handler error:", err);
    return res.status(500).json({ error: err.message ?? "Internal server error" });
  }
}

export async function zonesStreamHandler(req: Request, res: Response) {
  const { sessionId } = req.params;
  let sessionRow: any;

  try {
    const { rows } = await pool.query(
      `SELECT id, bbox, thresholds, altitude_floor, altitude_ceiling, last_snapshot FROM weather_monitor_sessions WHERE id = $1 AND expires_at > NOW()`,
      [sessionId]
    );
    if (!rows.length) return res.status(404).json({ error: "Session not found or expired. Call POST /api/zones to start a new session." });
    sessionRow = rows[0];
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const snapshot = await getSnapshot(sessionId);
if (snapshot) {
  res.write(`data: ${JSON.stringify({ ...(snapshot as object), type: "reconnect_snapshot" })}\n\n`);
} else {
  res.write(`data: ${JSON.stringify({ type: "connected", session_id: sessionId })}\n\n`);
}

  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { clearInterval(ping); } }, 30_000);
  res.on("close", () => clearInterval(ping));

  const session = await getSession(sessionId);
   if (!session) {
     const bbox: BBox              = sessionRow.bbox;
     const thresholds: DroneThresholds = sessionRow.thresholds;
     // FIX-3D-VOLUME: carry altitude through on the Redis-cold-restart path too
     const altitude: SessionAltitude = {
       floor:   typeof sessionRow.altitude_floor   === "number" ? sessionRow.altitude_floor   : 0,
       ceiling: typeof sessionRow.altitude_ceiling === "number" ? sessionRow.altitude_ceiling : 400,
     };
     await createSession(sessionId, bbox, thresholds, altitude);
   }
   registerClient(sessionId, res);
  }
