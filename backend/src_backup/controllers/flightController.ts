// backend/src/controllers/flightController.ts
// Three endpoints:
//
//   POST   /api/flight/start         — register a flight, link to monitor session
//   POST   /api/flight/:id/position  — receive actual GPS, check stateless, respond
//   DELETE /api/flight/:id           — land, expire session
//
// No position is stored. Each position check is compute-and-respond.
// The drone/GCS calls /position every X seconds with actual GPS.

import { Request, Response } from "express";
import { pool } from "../config/db";
import { checkDronePosition } from "../services/flightService";
import { isValidLatLon } from "../utils/validators";

// ─── POST /api/flight/start ───────────────────────────────────────────────────
// Operator calls this at takeoff after a successful /scan.
// Links the flight to a monitor session for SSE push alerts.
// Stores the pre-flight safe_airspace polygon for mid-flight comparison.

export async function startFlight(req: Request, res: Response) {
  try {
    const {
      destination,
      altitude_ceiling,
      safe_airspace,      // GeoJSON polygon from the pre-flight /scan response
      monitor_session_id, // from POST /api/zones (optional but recommended)
    } = req.body;

    if (!isValidLatLon(destination))
      return res.status(400)on({ error: "Invalid destination coordinates" });

    const apiKeyId = (req as any).apiKeyId; // set by auth middleware

    // Store safe_airspace if provided — used for mid-flight polygon comparison
    const safeAirspaceSQL = safe_airspace
      ? `ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)`
      : `NULL`;

    const params: any[] = [
      apiKeyId,
      destination.lat,
      destination.lon,
      altitude_ceiling ?? 400,
    ];
    if (safe_airspace) params.push(JSON.stringify(safe_airspace));
    if (monitor_session_id) params.push(monitor_session_id);

    const monitorParam = monitor_session_id
      ? `$${params.length}`
      : "NULL";

    const { rows } = await pool.query(`
      INSERT INTO public.flight_sessions
        (api_key_id, destination_lat, destination_lon, altitude_ceiling, safe_airspace, monitor_session_id)
      VALUES
        ($1, $2, $3, $4, ${safeAirspaceSQL}, ${monitorParam})
      RETURNING id, expires_at
    `, params);

    return res.status(201)on({
      flight_session_id: rows[0].id,
      expires_at:        rows[0].expires_at,
      message:           "Flight session started. Send GPS position to /api/flight/:id/position",
    });

  } catch (err: any) {
    console.error("startFlight error:", err);
    return res.status(500)on({ error: err.message });
  }
}

// ─── POST /api/flight/:id/position ───────────────────────────────────────────
// Called by drone/GCS every X seconds with actual GPS position.
// Stateless — checks airspace + weather at actual position right now.
// No position stored. Pushes SSE alert if issues detected.

export async function updatePosition(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { lat, lon, altitude } = req.body;

    if (!lat || !lon || typeof lat !== "number" || typeof lon !== "number")
      return res.status(400)on({ error: "lat and lon required as numbers" });

    // Load flight session — destination + monitor_session_id
    const { rows: sessionRows } = await pool.query(`
      SELECT
        destination_lat,
        destination_lon,
        monitor_session_id,
        expires_at
      FROM public.flight_sessions
      WHERE id = $1
    `, [id]);

    if (!sessionRows.length)
      return res.status(404)on({ error: "Flight session not found" });

    const session = sessionRows[0];

    if (new Date(session.expires_at) < new Date())
      return res.status(410)on({ error: "Flight session expired" });

    const current     = { lat, lon };
    const destination = {
      lat: parseFloat(session.destination_lat),
      lon: parseFloat(session.destination_lon),
    };

    // Stateless check — actual GPS, actual time, no history
    const result = await checkDronePosition(
      id,
      session.monitor_session_id,
      current,
      destination
    );

    return res.status(200)on({
      safe:                 result.safe,
      inside_safe_airspace: result.inside_safe_airspace,
      current_weather:      result.current_weather,
      remaining_minutes:    result.remaining_minutes,
      path_weather_safe:    result.path_weather_safe,
      restricted_windows:   result.restricted_windows,
      alert_pushed:         result.alert_pushed,
      checked_at:           new Date().toISOString(),
    });

  } catch (err: any) {
    console.error("updatePosition error:", err);
    return res.status(500)on({ error: err.message });
  }
}

// ─── DELETE /api/flight/:id ───────────────────────────────────────────────────
// Called at landing. Expires the session immediately.

export async function endFlight(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const { rowCount } = await pool.query(`
      UPDATE public.flight_sessions
      SET expires_at = NOW()
      WHERE id = $1
    `, [id]);

    if (!rowCount)
      return res.status(404)on({ error: "Flight session not found" });

    return res.status(200)on({
      message:    "Flight session ended",
      landed_at:  new Date().toISOString(),
    });

  } catch (err: any) {
    console.error("endFlight error:", err);
    return res.status(500)on({ error: err.message });
  }
}
