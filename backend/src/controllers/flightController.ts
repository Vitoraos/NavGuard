import { Request, Response } from "express";
import { pool } from "../config/db";
import { checkDronePosition, WeatherThresholds } from "../services/flightService";
import { isValidLatLon } from "../utils/validators";
import { queryAirspace } from "../services/ruleService";
import { queryWeatherTimeline } from "../services/ruleService";
import { auditLog } from "../services/auditService";

const CONTINGENCY_BUFFER_M = 500;

interface AuthRequest extends Request {
  apiKeyId?: string;
}

// BUILD-02: shared contingency check — used by both /scan and /flight/:id/contingency
async function checkContingencyPoint(
  point:      { lat: number; lon: number },
  floor:      number,
  ceil:       number,
  thresholds: { max_wind_mph: number; max_precip: number; min_visibility: number }
): Promise<{
  cleared:       boolean;
  restrictions:  object[];
  weather_clear: boolean;
  no_fly:        { regulatory: object | null; weather: object | null };
}> {
  const now      = new Date();
  const fiveMin  = new Date(now.getTime() + 5 * 60 * 1000);

  const [result, weatherTimeline] = await Promise.all([
    queryAirspace(point, point, CONTINGENCY_BUFFER_M, floor, ceil, now, fiveMin, thresholds),
    queryWeatherTimeline(point, point, now, 5 * 60),
  ]);

  return {
    cleared:       result.path_connected && weatherTimeline.restricted_windows.length === 0,
    restrictions:  result.restrictions,
    weather_clear: weatherTimeline.restricted_windows.length === 0,
    no_fly:        result.no_fly,
  };
}

export async function startFlight(req: AuthRequest, res: Response) {
  try {
    const { destination, altitude_ceiling, safe_airspace, monitor_session_id } = req.body;
    const apiKeyId = req.apiKeyId;

    if (!isValidLatLon(destination))
      return res.status(400).json({ error: "Invalid destination coordinates" });
    if (!apiKeyId)
      return res.status(401).json({ error: "Missing API key identity" });

    const ceil = Number(altitude_ceiling ?? 400);
    if (!Number.isFinite(ceil) || ceil < 0 || ceil > 10000)
      return res.status(400).json({ error: "altitude_ceiling must be a number between 0 and 10000" });

    if (safe_airspace !== undefined && safe_airspace !== null) {
      if (typeof safe_airspace !== "object" || safe_airspace.type === undefined || safe_airspace.coordinates === undefined)
        return res.status(400).json({ error: "safe_airspace must be a valid GeoJSON geometry" });
    }

    if (monitor_session_id !== undefined && monitor_session_id !== null && typeof monitor_session_id !== "string")
      return res.status(400).json({ error: "monitor_session_id must be a string" });

    const safeAirspaceValue = safe_airspace ? JSON.stringify(safe_airspace) : null;
    const { rows } = await pool.query(`
      INSERT INTO public.flight_sessions
        (api_key_id, destination_lat, destination_lon, altitude_ceiling, safe_airspace, monitor_session_id)
      VALUES ($1, $2, $3, $4,
        CASE WHEN $5::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($5), 4326) END, $6)
      RETURNING id, expires_at
    `, [apiKeyId, destination.lat, destination.lon, ceil, safeAirspaceValue, monitor_session_id ?? null]);

    if (!rows.length)
      return res.status(500).json({ error: "Insert did not return a row" });

    const successResponse = {
      flight_session_id: rows[0].id,
      expires_at:        rows[0].expires_at,
      message:           "Flight session started. Send GPS position to /api/flight/:id/position",
    };

    auditLog({
      endpoint:        "POST /flight/start",
      apiKeyId,
      flightSessionId: rows[0].id,
      summary: {
        flight_session_id:   rows[0].id,
        altitude_ceiling:    ceil,
        has_safe_airspace:   !!safe_airspace,
        has_monitor_session: !!monitor_session_id,
        expires_at:          rows[0].expires_at,
      },
      fullResponse: successResponse,
    });

    return res.status(201).json(successResponse);

  } catch (err: unknown) {
    console.error("startFlight error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

export async function updatePosition(req: Request, res: Response) {
  try {
    const { id }     = req.params;
    const apiKeyId   = (req as any).apiKeyId;

    if (!id || typeof id !== "string" || id.trim() === "")
      return res.status(400).json({ error: "Invalid session id" });

    const { lat, lon, altitude, ground_speed_ms, heading, thresholds } = req.body;

    if (lat === undefined || lat === null || lon === undefined || lon === null)
      return res.status(400).json({ error: "lat and lon are required" });
    if (typeof lat !== "number" || typeof lon !== "number")
      return res.status(400).json({ error: "lat and lon must be numbers" });

    const altitudeAGL_ft: number = typeof altitude === "number" && Number.isFinite(altitude) ? altitude : 0;
    const groundSpeedMs:  number = typeof ground_speed_ms === "number" && Number.isFinite(ground_speed_ms) && ground_speed_ms > 0
      ? ground_speed_ms : 10;

    const { rows: sessionRows } = await pool.query(`
      SELECT destination_lat, destination_lon, monitor_session_id, expires_at, altitude_floor, altitude_ceiling
      FROM public.flight_sessions WHERE id = $1
    `, [id]);

    if (!sessionRows.length)
      return res.status(404).json({ error: "Flight session not found" });

    const session = sessionRows[0];
    if (new Date(session.expires_at) < new Date())
      return res.status(410).json({ error: "Flight session expired" });

    const current     = { lat, lon };
    const destination = { lat: parseFloat(session.destination_lat), lon: parseFloat(session.destination_lon) };
    const sessionLimits = {
      floor:   typeof session.altitude_floor   === "number" ? session.altitude_floor   : 0,
      ceiling: typeof session.altitude_ceiling === "number" ? session.altitude_ceiling : 400,
    };

    const safeThresholds: WeatherThresholds = {
      max_wind_mph:   Number(thresholds?.max_wind_mph   ?? 25),
      max_precip:     Number(thresholds?.max_precip     ?? 2),
      min_visibility: Number(thresholds?.min_visibility ?? 1000),
    };

    const result = await checkDronePosition(
      id, session.monitor_session_id, current, destination,
      altitudeAGL_ft, sessionLimits, groundSpeedMs, safeThresholds, heading
    );

    const successResponse = {
      safe:                 result.safe,
      inside_safe_airspace: result.inside_safe_airspace,
      new_tfr_activated:    result.new_tfr_activated,
      tfr_name:             result.tfr_name,
      current_weather:      result.current_weather,
      remaining_minutes:    result.remaining_minutes,
      restricted:           result.restricted,
      path_weather_safe:    result.path_weather_safe,
      alert_pushed:         result.alert_pushed,
      checked_at:           new Date().toISOString(),
    };

    auditLog({
      endpoint:        "POST /flight/:id/position",
      apiKeyId,
      flightSessionId: id,
      summary: {
        inside_safe_airspace: result.inside_safe_airspace,
        new_tfr_activated:    result.new_tfr_activated,
        tfr_name:             result.tfr_name ?? null,
        weather_restricted:   result.current_weather.restricted,
        weather_reasons:      result.current_weather.reasons,
        path_weather_safe:    result.path_weather_safe,
        overall_safe:         result.safe,
        remaining_minutes:    result.remaining_minutes,
        altitude_agl_ft:      altitudeAGL_ft,
        checked_at:           successResponse.checked_at,
      },
      fullResponse: successResponse,
    });

    return res.status(200).json(successResponse);

  } catch (err: unknown) {
    console.error("updatePosition error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

// BUILD-02: update contingency landing point mid-flight
export async function updateContingency(req: Request, res: Response) {
  try {
    const { id }   = req.params;
    const apiKeyId = (req as any).apiKeyId;

    if (!id || typeof id !== "string" || id.trim() === "")
      return res.status(400).json({ error: "Invalid session id" });

    const { contingency_landing, thresholds } = req.body;

    if (!isValidLatLon(contingency_landing))
      return res.status(400).json({ error: "contingency_landing must be { lat, lon } with valid coordinates" });

    const { rows: sessionRows } = await pool.query(`
      SELECT altitude_floor, altitude_ceiling, expires_at
      FROM public.flight_sessions WHERE id = $1
    `, [id]);

    if (!sessionRows.length)
      return res.status(404).json({ error: "Flight session not found" });

    const session = sessionRows[0];
    if (new Date(session.expires_at) < new Date())
      return res.status(410).json({ error: "Flight session expired" });

    const floor = typeof session.altitude_floor   === "number" ? session.altitude_floor   : 0;
    const ceil  = typeof session.altitude_ceiling === "number" ? session.altitude_ceiling : 400;

    const safeThresholds = {
      max_wind_mph:   Number(thresholds?.max_wind_mph   ?? 25),
      max_precip:     Number(thresholds?.max_precip     ?? 2),
      min_visibility: Number(thresholds?.min_visibility ?? 1000),
    };

    const contingencyResult = await checkContingencyPoint(
      contingency_landing, floor, ceil, safeThresholds
    );

    // Persist result to flight session for audit trail
    await pool.query(`
      UPDATE public.flight_sessions SET
        contingency_lat          = $1,
        contingency_lon          = $2,
        contingency_cleared      = $3,
        contingency_checked_at   = NOW(),
        contingency_restrictions = $4
      WHERE id = $5
    `, [
      contingency_landing.lat,
      contingency_landing.lon,
      contingencyResult.cleared,
      JSON.stringify(contingencyResult.restrictions),
      id,
    ]);

    const successResponse = {
      flight_session_id: id,
      contingency_landing,
      cleared:           contingencyResult.cleared,
      weather_clear:     contingencyResult.weather_clear,
      restrictions:      contingencyResult.restrictions,
      no_fly:            contingencyResult.no_fly,
      checked_at:        new Date().toISOString(),
    };

    auditLog({
      endpoint:        "POST /flight/:id/contingency",
      apiKeyId,
      flightSessionId: id,
      summary: {
        contingency_cleared:       contingencyResult.cleared,
        contingency_weather_clear: contingencyResult.weather_clear,
        contingency_restrictions:  contingencyResult.restrictions.length,
        checked_at:                successResponse.checked_at,
      },
      fullResponse: successResponse,
    });

    return res.status(200).json(successResponse);

  } catch (err: unknown) {
    console.error("updateContingency error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}

export async function endFlight(req: Request, res: Response) {
  try {
    const { id }   = req.params;
    const apiKeyId = (req as any).apiKeyId;

    if (!id || typeof id !== "string" || id.trim() === "")
      return res.status(400).json({ error: "Invalid session id" });

    const { rowCount } = await pool.query(`
      UPDATE public.flight_sessions SET expires_at = NOW() WHERE id = $1
    `, [id]);

    if (!rowCount)
      return res.status(404).json({ error: "Flight session not found" });

    const successResponse = {
      message:   "Flight session ended",
      landed_at: new Date().toISOString(),
    };

    auditLog({
      endpoint:        "DELETE /flight/:id",
      apiKeyId,
      flightSessionId: id,
      summary: {
        flight_session_id: id,
        landed_at:         successResponse.landed_at,
      },
      fullResponse: successResponse,
    });

    return res.status(200).json(successResponse);

  } catch (err: unknown) {
    console.error("endFlight error:", err);
    return res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
}
