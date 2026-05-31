import { Request, Response } from "express";
import { pool } from "../config/db";
import { checkDronePosition } from "../services/flightService";
import { isValidLatLon } from "../utils/validators";

interface AuthRequest extends Request {
  apiKeyId?: string;
}

export async function startFlight(req: AuthRequest, res: Response) {
  try {
    const {
      destination,
      altitude_ceiling,
      safe_airspace,
      monitor_session_id,
    } = req.body;

    if (!isValidLatLon(destination))
      return res.status(400).json({ error: "Invalid destination coordinates" });

    const apiKeyId = req.apiKeyId;
    if (!apiKeyId)
      return res.status(401).json({ error: "Missing API key identity" });

    const ceil = Number(altitude_ceiling ?? 400);
    if (!Number.isFinite(ceil) || ceil < 0 || ceil > 10000)
      return res.status(400).json({ error: "altitude_ceiling must be a number between 0 and 10000" });

    if (safe_airspace !== undefined && safe_airspace !== null) {
      if (
        typeof safe_airspace !== "object" ||
        safe_airspace.type === undefined ||
        safe_airspace.coordinates === undefined
      )
        return res.status(400).json({ error: "safe_airspace must be a valid GeoJSON geometry" });
    }

    if (
      monitor_session_id !== undefined &&
      monitor_session_id !== null &&
      typeof monitor_session_id !== "string"
    )
      return res.status(400).json({ error: "monitor_session_id must be a string" });

    // Fixed: stable param positions regardless of optional fields
    const safeAirspaceValue = safe_airspace ? JSON.stringify(safe_airspace) : null;
    const { rows } = await pool.query(`
      INSERT INTO public.flight_sessions
        (api_key_id, destination_lat, destination_lon, altitude_ceiling, safe_airspace, monitor_session_id)
      VALUES
        ($1, $2, $3, $4,
         CASE WHEN $5::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($5), 4326) END,
         $6)
      RETURNING id, expires_at
    `, [
      apiKeyId,
      destination.lat,
      destination.lon,
      ceil,
      safeAirspaceValue,
      monitor_session_id ?? null,
    ]);

    if (!rows.length)
      return res.status(500).json({ error: "Insert did not return a row" });

    return res.status(201).json({
      flight_session_id: rows[0].id,
      expires_at:        rows[0].expires_at,
      message:           "Flight session started. Send GPS position to /api/flight/:id/position",
    });
  } catch (err: unknown) {
    console.error("startFlight error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

export async function updatePosition(req: Request, res: Response) {
  try {
    const { id } = req.params;

    // Fixed: validate id format before querying
    if (!id || typeof id !== "string" || id.trim() === "")
      return res.status(400).json({ error: "Invalid session id" });

    const { lat, lon, altitude } = req.body;

    // Fixed: !lat rejects 0 — use explicit null/undefined check instead
    if (lat === undefined || lat === null || lon === undefined || lon === null)
      return res.status(400).json({ error: "lat and lon are required" });
    if (typeof lat !== "number" || typeof lon !== "number")
      return res.status(400).json({ error: "lat and lon must be numbers" });

    // Fixed: validate altitude before passing to service
    const altitudeFt: number = typeof altitude === "number" && Number.isFinite(altitude)
      ? altitude
      : 0;

    const { rows: sessionRows } = await pool.query(`
      SELECT
        destination_lat,
        destination_lon,
        monitor_session_id,
        expires_at,
        altitude_floor,
        altitude_ceiling
      FROM public.flight_sessions
      WHERE id = $1
    `, [id]);

    if (!sessionRows.length)
      return res.status(404).json({ error: "Flight session not found" });

    const session = sessionRows[0];

    if (new Date(session.expires_at) < new Date())
      return res.status(410).json({ error: "Flight session expired" });

    const current     = { lat, lon };
    const destination = {
      lat: parseFloat(session.destination_lat),
      lon: parseFloat(session.destination_lon),
    };

    // Fixed: build sessionLimits from actual session values
    const sessionLimits = {
      floor:   typeof session.altitude_floor   === "number" ? session.altitude_floor   : 0,
      ceiling: typeof session.altitude_ceiling === "number" ? session.altitude_ceiling : 400,
    };

    const result = await checkDronePosition(
      id,
      session.monitor_session_id,
      current,
      destination,
      altitudeFt,
      sessionLimits
    );

    return res.status(200).json({
      safe:                 result.safe,
      inside_safe_airspace: result.inside_safe_airspace,
      current_weather:      result.current_weather,
      remaining_minutes:    result.remaining_minutes,
      path_weather_safe:    result.path_weather_safe,
      restricted_windows:   result.restricted_windows,
      alert_pushed:         result.alert_pushed,
      active_restriction:   result.active_restriction,
      checked_at:           new Date().toISOString(),
    });
  } catch (err: unknown) {
    console.error("updatePosition error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

export async function endFlight(req: Request, res: Response) {
  try {
    const { id } = req.params;

    if (!id || typeof id !== "string" || id.trim() === "")
      return res.status(400).json({ error: "Invalid session id" });

    const { rowCount } = await pool.query(`
      UPDATE public.flight_sessions
      SET expires_at = NOW()
      WHERE id = $1
    `, [id]);

    if (!rowCount)
      return res.status(404).json({ error: "Flight session not found" });

    return res.status(200).json({
      message:   "Flight session ended",
      landed_at: new Date().toISOString(),
    });
  } catch (err: unknown) {
    console.error("endFlight error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
