import { pool } from "../config/db";
import { queryWeatherTimeline, RestrictedWindow } from "./ruleService";
import { RestrictionState } from "../types/restrictions";
import { broadcast } from "./monitorService";

function selectBand(altitudeMSL_ft: number): string {
  if (altitudeMSL_ft < 2500) return "surface";
  if (altitudeMSL_ft < 5000) return "925hPa";
  return "850hPa";
}

export async function getElevationAtPoint(lon: number, lat: number): Promise<number> {
  const { rows } = await pool.query(`
    SELECT elevation_m FROM weather_grid 
    WHERE fetched_at > NOW() - INTERVAL '40 minutes' 
    ORDER BY ST_Distance(
      ST_Transform(geom, 3857), 
      ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857)
    ) 
    LIMIT 1
  `, [lon, lat]);
  return rows[0]?.elevation_m ?? 0;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const DEFAULT_DRONE_SPEED_KMH = 48;
const DURATION_BUFFER = 1.5;
const MIN_DURATION_MIN = 5;
const MAX_DURATION_MIN = 120;

function estimateRemainingSeconds(current: { lat: number; lon: number }, destination: { lat: number; lon: number }, groundSpeedKmh: number = DEFAULT_DRONE_SPEED_KMH): number {
  const distKm = haversineKm(current.lat, current.lon, destination.lat, destination.lon);
  const rawMinutes = (distKm / groundSpeedKmh) * 60 * DURATION_BUFFER;
  const minutes = Math.max(MIN_DURATION_MIN, Math.min(MAX_DURATION_MIN, Math.ceil(rawMinutes)));
  return minutes * 60;
}

async function checkInsideSafeAirspace(
  current: { lat: number; lon: number },
  flightSessionId: string,
  altitudeMSL_ft: number = 0,
  sessionLimits: { floor: number; ceiling: number } = { floor: 0, ceiling: 400 }
): Promise<{ inside: boolean; new_tfr_hit: boolean; tfr_name: string | null }> {
  const { rows: safeRows } = await pool.query(
    `SELECT ST_Within(ST_SetSRID(ST_MakePoint($1, $2), 4326), safe_airspace) AS inside FROM flight_sessions WHERE id = $3 AND safe_airspace IS NOT NULL`,
    [current.lon, current.lat, flightSessionId]
  );
  const insideStored = safeRows[0]?.inside ?? true;

  const { rows: tfrRows } = await pool.query(
    `SELECT id, name FROM nfz_zones WHERE ST_Within(ST_SetSRID(ST_MakePoint($1, $2), 4326), geom) AND altitude_floor <= $4 AND altitude_ceiling >= $4 AND (start_time IS NULL OR start_time >= (SELECT created_at FROM flight_sessions WHERE id = $3)) AND (end_time IS NULL OR end_time > NOW()) LIMIT 1`,
    [current.lon, current.lat, flightSessionId, altitudeMSL_ft]
  );

  const newTfrHit = tfrRows.length > 0;
  const withinVertical = altitudeMSL_ft >= sessionLimits.floor && altitudeMSL_ft <= sessionLimits.ceiling;

  return { inside: insideStored && !newTfrHit && withinVertical, new_tfr_hit: newTfrHit, tfr_name: newTfrHit ? tfrRows[0].name : null };
}

interface PositionWeather { restricted: boolean; wind_mph: number; precip: number; visibility: number; reasons: string[]; }
export interface WeatherThresholds { max_wind_mph: number; max_precip: number; min_visibility: number; }

async function getWeatherAtPosition(
  current: { lat: number; lon: number },
  altitudeMSL_ft: number,
  sessionCeiling: number,
  thresholds: WeatherThresholds
): Promise<PositionWeather> {
  const { rows } = await pool.query(
    `SELECT restricted, wind_mph, precip, visibility FROM weather_grid WHERE fetched_at > NOW() - INTERVAL '40 minutes' AND altitude_band = $3 ORDER BY ST_Distance(ST_Transform(geom, 3857), ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857)) LIMIT 1`,
    [current.lon, current.lat, selectBand(altitudeMSL_ft)]
  );

  if (!rows.length) return { restricted: false, wind_mph: 0, precip: 0, visibility: 9999, reasons: ["No weather data available"] };

  const r = rows[0];
  const reasons: string[] = [];
  if (r.wind_mph > thresholds.max_wind_mph) reasons.push(`Wind ${r.wind_mph.toFixed(1)} mph exceeds ${thresholds.max_wind_mph} mph limit`);
  if (r.precip > thresholds.max_precip) reasons.push(`Precipitation ${r.precip.toFixed(1)} mm/hr exceeds ${thresholds.max_precip} limit`);
  if (r.visibility < thresholds.min_visibility) reasons.push(`Visibility ${r.visibility}m below ${thresholds.min_visibility}m minimum`);
  if (altitudeMSL_ft > sessionCeiling) reasons.push(`Altitude ${altitudeMSL_ft}ft exceeds ${sessionCeiling}ft approved ceiling`);

  return { restricted: reasons.length > 0, wind_mph: r.wind_mph, precip: r.precip, visibility: r.visibility, reasons };
}

// FIX-01: broadcast to SSE clients immediately after persisting to DB
async function pushAlert(monitorSessionId: string, alert: object): Promise<void> {
  await pool.query(
    `UPDATE weather_monitor_sessions SET last_snapshot = COALESCE(last_snapshot, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [monitorSessionId, JSON.stringify({ position_alert: alert, alerted_at: new Date().toISOString() })]
  );

  await broadcast(monitorSessionId, {
    type: "position_alert",
    ...(alert as object),
  });
}

async function checkImmediateHorizon(
  current: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  altitudeMSL_ft: number,
  groundSpeedMs: number,
  horizonSeconds: number,
  headingDeg?: number
): Promise<boolean> {
  let headingRad: number;
  if (headingDeg !== undefined && !isNaN(headingDeg)) {
    headingRad = (headingDeg * Math.PI) / 180;
  } else {
    const dLat = destination.lat - current.lat;
    const dLon = destination.lon - current.lon;
    headingRad = Math.atan2(dLon, dLat);
  }

  const distanceMeters = groundSpeedMs * horizonSeconds;

  const sql = `
    WITH future_pos AS (
      SELECT ST_Project(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3, $4)::geometry AS geom
    ),
    flight_vector AS (
      SELECT ST_MakeLine(ST_SetSRID(ST_MakePoint($1, $2), 4326), (SELECT geom FROM future_pos)) AS line_geom
    )
    SELECT CASE WHEN COUNT(*) > 0 THEN false ELSE true END as is_safe
    FROM weather_grid wg
    CROSS JOIN flight_vector fv
    WHERE ST_DWithin(wg.geom::geography, fv.line_geom::geography, 5000)
      AND wg.altitude_band = $5
      AND wg.fetched_at > NOW() - INTERVAL '40 minutes'
      AND (wg.wind_mph > $6 OR wg.precip > $7 OR wg.visibility < $8);
  `;

  const { rows } = await pool.query(sql, [
    current.lon, current.lat, distanceMeters, headingRad,
    selectBand(altitudeMSL_ft), 25, 2, 1000
  ]);

  return rows[0]?.is_safe ?? true;
}

export interface PositionCheckResult {
  safe: boolean;
  inside_safe_airspace: boolean;
  new_tfr_activated: boolean;
  tfr_name: string | null;
  current_weather: PositionWeather;
  remaining_minutes: number;
  restricted: RestrictionState;
  path_weather_safe: boolean;
  alert_pushed: boolean;
}

export async function checkDronePosition(
  flightSessionId: string,
  monitorSessionId: string | null,
  current: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  altitudeAGL_ft: number = 0,
  sessionLimits: { floor: number; ceiling: number } = { floor: 0, ceiling: 400 },
  groundSpeedMs: number = 10,
  thresholds: WeatherThresholds = { max_wind_mph: 25, max_precip: 2, min_visibility: 1000 },
  headingDeg?: number
): Promise<PositionCheckResult> {
  const groundSpeedKmh = groundSpeedMs * 3.6;
  const remainingSeconds = estimateRemainingSeconds(current, destination, groundSpeedKmh);
  const remainingMinutes = Math.ceil(remainingSeconds / 60);

  const elevationM = await getElevationAtPoint(current.lon, current.lat);
  const altitudeMSL_ft = altitudeAGL_ft + (elevationM * 3.28084);

  const safeAirspaceCheck = await checkInsideSafeAirspace(current, flightSessionId, altitudeMSL_ft, sessionLimits);
  const currentWeather = await getWeatherAtPosition(current, altitudeMSL_ft, sessionLimits.ceiling, thresholds);

  const horizonSeconds = Math.min(120, Math.ceil(5000 / groundSpeedMs));
  const immediateHorizonSafe = await checkImmediateHorizon(current, destination, altitudeMSL_ft, groundSpeedMs, horizonSeconds, headingDeg);

  const insideSafe = safeAirspaceCheck.inside;
  const overallSafe = insideSafe && !currentWeather.restricted && immediateHorizonSafe;

  const restrictionState: RestrictionState = { windows: [], active: null };

  let alertPushed = false;
  if (!overallSafe && monitorSessionId) {
    await pushAlert(monitorSessionId, {
      type: "position_check_alert",
      inside_safe_airspace: insideSafe,
      new_tfr_activated: safeAirspaceCheck.new_tfr_hit,
      tfr_name: safeAirspaceCheck.tfr_name,
      current_weather: currentWeather,
      restricted: restrictionState,
      current_position: current,
      remaining_minutes: remainingMinutes,
    });
    alertPushed = true;
  }

  return {
    safe: overallSafe,
    inside_safe_airspace: insideSafe,
    new_tfr_activated: safeAirspaceCheck.new_tfr_hit,
    tfr_name: safeAirspaceCheck.tfr_name,
    current_weather: currentWeather,
    remaining_minutes: remainingMinutes,
    restricted: restrictionState,
    path_weather_safe: immediateHorizonSafe,
    alert_pushed: alertPushed,
  };
}
