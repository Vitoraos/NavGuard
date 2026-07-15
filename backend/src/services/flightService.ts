import { pool } from "../config/db";
import { redis } from "../config/redis";
import { queryWeatherTimeline, RestrictedWindow } from "./ruleService";
import { RestrictionState } from "../types/restrictions";
import { broadcast } from "./monitorService";

// ============================================================================
// FIX-CONFIG: values that were previously hardcoded constants or magic
// numbers scattered through this file, now centralized and env-overridable.
// Nothing here changes default behavior — same numbers as before unless an
// env var is set — but every one of these is now a single tunable knob
// instead of a search-and-replace across functions.
// ============================================================================
export const FLIGHT_CONFIG = {
  // ETA / closure-rate
  DEFAULT_DRONE_SPEED_KMH:      Number(process.env.DEFAULT_DRONE_SPEED_KMH ?? 48),
  DURATION_BUFFER:              Number(process.env.DURATION_BUFFER ?? 1.5),
  MIN_DURATION_MIN:             Number(process.env.MIN_DURATION_MIN ?? 5),
  MAX_DURATION_MIN:             Number(process.env.MAX_DURATION_MIN ?? 120),

  // FIX-ETA-HEADING: floor so a drone heading away from / perpendicular to the
  // destination doesn't send ETA to infinity or negative; it's clamped to
  // "barely closing" instead so remaining_minutes stays a usable number.
  CLOSURE_FLOOR:                Number(process.env.CLOSURE_FLOOR ?? 0.05),
  // cos(~32deg) — heading within this of the direct bearing counts as "on course"
  ON_COURSE_THRESHOLD:          Number(process.env.ON_COURSE_THRESHOLD ?? 0.85),
  // cos(~72deg) — below this counts as "low/negative closure" for divergence tracking
  LOW_CLOSURE_THRESHOLD:        Number(process.env.LOW_CLOSURE_THRESHOLD ?? 0.3),

  // FIX-DIVERGENCE: sustained-divergence alerting tunables
  DIVERGENCE_ALERT_SECONDS:     Number(process.env.DIVERGENCE_ALERT_SECONDS ?? 20),
  DIVERGENCE_REALERT_SECONDS:   Number(process.env.DIVERGENCE_REALERT_SECONDS ?? 60),
  DIVERGENCE_KEY_TTL_SECONDS:   Number(process.env.DIVERGENCE_KEY_TTL_SECONDS ?? 600),

  // Immediate-horizon lookahead
  HORIZON_MAX_SECONDS:          Number(process.env.HORIZON_MAX_SECONDS ?? 120),
  HORIZON_MAX_DISTANCE_M:       Number(process.env.HORIZON_MAX_DISTANCE_M ?? 5000),
  HORIZON_CORRIDOR_BUFFER_M:    Number(process.env.HORIZON_CORRIDOR_BUFFER_M ?? 5000),

  // Weather data freshness + interpolation
  WEATHER_DATA_STALE_MIN:       Number(process.env.WEATHER_DATA_STALE_MIN ?? 40),
  // FIX-IDW: number of nearest grid cells to blend instead of nearest-1 snap
  IDW_NEAREST_N:                Number(process.env.IDW_NEAREST_N ?? 4),
};

function selectBand(altitudeMSL_ft: number): string {
  if (altitudeMSL_ft < 2500) return "surface";
  if (altitudeMSL_ft < 5000) return "925hPa";
  return "850hPa";
}

// FIX-KNN: uses the `<->` KNN operator (index-assisted) instead of
// `ORDER BY ST_Distance(...) LIMIT 1`, which forces a full scan-and-sort.
// Requires: CREATE INDEX IF NOT EXISTS weather_grid_geom_gist ON weather_grid USING GIST (geom);
export async function getElevationAtPoint(lon: number, lat: number): Promise<number> {
  const { rows } = await pool.query(`
    SELECT elevation_m FROM weather_grid
    WHERE fetched_at > NOW() - INTERVAL '${FLIGHT_CONFIG.WEATHER_DATA_STALE_MIN} minutes'
    ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
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

// Proper initial-bearing formula (great-circle), used both as the ETA closure
// reference and as the fallback heading when the drone doesn't report one.
function bearingRad(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
  return Math.atan2(y, x);
}

interface EtaResult {
  seconds: number;
  closure_factor: number;
  on_course: boolean;
}

// FIX-ETA-HEADING: previously this assumed the drone flies directly toward
// the destination at full ground speed (distance / speed). Now, if a heading
// is reported, only the component of ground speed actually pointed at the
// destination counts toward closing the distance — a drone flying sideways
// to the destination line closes distance much slower than its raw speed.
function estimateRemainingSeconds(
  current: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  groundSpeedKmh: number = FLIGHT_CONFIG.DEFAULT_DRONE_SPEED_KMH,
  headingDeg?: number
): EtaResult {
  const distKm = haversineKm(current.lat, current.lon, destination.lat, destination.lon);

  let closureFactor = 1;
  if (headingDeg !== undefined && !isNaN(headingDeg) && distKm > 0.01) {
    const bearingToDestRad = bearingRad(current.lat, current.lon, destination.lat, destination.lon);
    const headingRad = (headingDeg * Math.PI) / 180;
    closureFactor = Math.cos(headingRad - bearingToDestRad);
  }

  const effectiveClosure = Math.max(closureFactor, FLIGHT_CONFIG.CLOSURE_FLOOR);
  const effectiveSpeedKmh = groundSpeedKmh * effectiveClosure;

  const rawMinutes = (distKm / effectiveSpeedKmh) * 60 * FLIGHT_CONFIG.DURATION_BUFFER;
  const minutes = Math.max(
    FLIGHT_CONFIG.MIN_DURATION_MIN,
    Math.min(FLIGHT_CONFIG.MAX_DURATION_MIN, Math.ceil(rawMinutes))
  );

  return {
    seconds: minutes * 60,
    closure_factor: closureFactor,
    on_course: closureFactor >= FLIGHT_CONFIG.ON_COURSE_THRESHOLD,
  };
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

interface PositionWeather {
  restricted: boolean;
  wind_mph: number;
  gust_mph: number | null; // null = gust not modeled at this altitude_band (e.g. 925hPa/850hPa)
  precip: number;
  visibility: number;
  reasons: string[];
  cells_used: number; // FIX-IDW diagnostic: how many grid cells contributed to this reading
}
// FIX-GUST: max_gust_mph added. Gusts are frequently the actual cause of loss
// of control for small delivery airframes, distinct from sustained wind —
// a day can be well within sustained-wind limits and still gust past what
// the airframe can hold attitude through.
export interface WeatherThresholds {
  max_wind_mph: number;
  max_gust_mph: number;
  max_precip: number;
  min_visibility: number;
}

// FIX-IDW: previously snapped to the single nearest grid cell (ORDER BY
// ST_Distance LIMIT 1), which treats weather as a step function with a hard
// edge at the midpoint between two grid cells (~12-14km apart at this grid
// spacing). Now blends the nearest N cells with inverse-distance weighting,
// so the value changes smoothly as the drone crosses the grid instead of
// jumping. Also switched to the KNN `<->` operator so this stays index-
// assisted even as IDW_NEAREST_N pulls more rows per lookup.
async function getWeatherAtPosition(
  current: { lat: number; lon: number },
  altitudeMSL_ft: number,
  sessionCeiling: number,
  thresholds: WeatherThresholds
): Promise<PositionWeather> {
  const { rows } = await pool.query(
    `
    WITH nearest AS (
      SELECT wind_mph, gust_mph, precip, visibility,
             ST_Distance(
               geom::geography,
               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
             ) AS d
      FROM weather_grid
      WHERE altitude_band = $3
        AND fetched_at > NOW() - INTERVAL '${FLIGHT_CONFIG.WEATHER_DATA_STALE_MIN} minutes'
      ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
      LIMIT $4
    )
    SELECT
      SUM(wind_mph   / GREATEST(d, 1)) / NULLIF(SUM(1 / GREATEST(d, 1)), 0) AS wind_mph,
      -- gust_mph is NULL for non-surface bands (not modeled there) — exclude
      -- NULL rows from the average instead of treating them as 0, so a mix
      -- of surface-adjacent and pressure-level cells doesn't silently dilute
      -- the gust reading toward "calm."
      SUM(gust_mph   / GREATEST(d, 1)) FILTER (WHERE gust_mph IS NOT NULL)
        / NULLIF(SUM(1 / GREATEST(d, 1)) FILTER (WHERE gust_mph IS NOT NULL), 0) AS gust_mph,
      SUM(precip     / GREATEST(d, 1)) / NULLIF(SUM(1 / GREATEST(d, 1)), 0) AS precip,
      SUM(visibility / GREATEST(d, 1)) / NULLIF(SUM(1 / GREATEST(d, 1)), 0) AS visibility,
      COUNT(*)::int AS cells_used
    FROM nearest;
    `,
    [current.lon, current.lat, selectBand(altitudeMSL_ft), FLIGHT_CONFIG.IDW_NEAREST_N]
  );

  const r = rows[0];
  if (!r || !r.cells_used) {
    return { restricted: false, wind_mph: 0, gust_mph: null, precip: 0, visibility: 9999, reasons: ["No weather data available"], cells_used: 0 };
  }

  const gustMph: number | null = r.gust_mph !== null && r.gust_mph !== undefined ? Number(r.gust_mph) : null;

  const reasons: string[] = [];
  if (r.wind_mph > thresholds.max_wind_mph) reasons.push(`Wind ${Number(r.wind_mph).toFixed(1)} mph exceeds ${thresholds.max_wind_mph} mph limit`);
  // FIX-GUST: only evaluated when gust data actually exists for this band —
  // absence of gust data is not evidence of calm conditions.
  if (gustMph !== null && gustMph > thresholds.max_gust_mph) reasons.push(`Gust ${gustMph.toFixed(1)} mph exceeds ${thresholds.max_gust_mph} mph limit`);
  if (r.precip > thresholds.max_precip) reasons.push(`Precipitation ${Number(r.precip).toFixed(1)} mm/hr exceeds ${thresholds.max_precip} limit`);
  if (r.visibility < thresholds.min_visibility) reasons.push(`Visibility ${Math.round(r.visibility)}m below ${thresholds.min_visibility}m minimum`);
  if (altitudeMSL_ft > sessionCeiling) reasons.push(`Altitude ${altitudeMSL_ft}ft exceeds ${sessionCeiling}ft approved ceiling`);

  return {
    restricted: reasons.length > 0,
    wind_mph: r.wind_mph,
    gust_mph: gustMph,
    precip: r.precip,
    visibility: r.visibility,
    reasons,
    cells_used: r.cells_used,
  };
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

// FIX-THRESHOLD-BUG: this previously hardcoded [25, 2, 1000] regardless of
// the caller-supplied thresholds, so a session flown under stricter or looser
// custom limits was silently checked against the wrong values for anything
// in the immediate lookahead window. Now takes `thresholds` and uses it.
// Also: fallback heading now uses the same great-circle bearingRad() as the
// ETA calc (previously a slightly different atan2(dLon, dLat) approximation).
// Corridor buffer is now a config value instead of a bare 5000 in the SQL.
async function checkImmediateHorizon(
  current: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  altitudeMSL_ft: number,
  groundSpeedMs: number,
  horizonSeconds: number,
  thresholds: WeatherThresholds,
  headingDeg?: number
): Promise<boolean> {
  const headingRad = (headingDeg !== undefined && !isNaN(headingDeg))
    ? (headingDeg * Math.PI) / 180
    : bearingRad(current.lat, current.lon, destination.lat, destination.lon);

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
    WHERE ST_DWithin(wg.geom::geography, fv.line_geom::geography, $9)
      AND wg.altitude_band = $5
      AND wg.fetched_at > NOW() - INTERVAL '${FLIGHT_CONFIG.WEATHER_DATA_STALE_MIN} minutes'
      AND (
        wg.wind_mph > $6
        OR wg.precip > $7
        OR wg.visibility < $8
        -- FIX-GUST: NULL gust_mph (non-surface bands) never trips this —
        -- absence of gust data isn't evidence of calm conditions.
        OR (wg.gust_mph IS NOT NULL AND wg.gust_mph > $10)
      );
  `;

  const { rows } = await pool.query(sql, [
    current.lon, current.lat, distanceMeters, headingRad,
    selectBand(altitudeMSL_ft),
    thresholds.max_wind_mph, thresholds.max_precip, thresholds.min_visibility,
    FLIGHT_CONFIG.HORIZON_CORRIDOR_BUFFER_M,
    thresholds.max_gust_mph,
  ]);

  return rows[0]?.is_safe ?? true;
}

// ============================================================================
// FIX-DIVERGENCE: tracks how long a flight session has had a low/negative
// closure factor (heading not making progress toward destination) using
// Redis, since this needs to persist across per-second polling calls to
// checkDronePosition, not just within a single call. Alerts once sustained
// past DIVERGENCE_ALERT_SECONDS, then re-alerts at most every
// DIVERGENCE_REALERT_SECONDS to avoid spamming the monitor session on every
// tick while still off course. Clears automatically once closure recovers.
// ============================================================================
interface DivergenceStatus {
  seconds_off_course: number;
  should_alert: boolean;
}

function divergenceKey(flightSessionId: string): string {
  return `navguard:divergence:${flightSessionId}`;
}

async function trackDivergence(flightSessionId: string, closureFactor: number): Promise<DivergenceStatus> {
  const key = divergenceKey(flightSessionId);
  const nowMs = Date.now();

  if (closureFactor >= FLIGHT_CONFIG.LOW_CLOSURE_THRESHOLD) {
    await redis.del(key);
    return { seconds_off_course: 0, should_alert: false };
  }

  const existing = await redis.hgetall(key);
  const since = existing?.since ? Number(existing.since) : nowMs;
  const lastAlertedAt = existing?.lastAlertedAt ? Number(existing.lastAlertedAt) : 0;

  if (!existing?.since) {
    await redis.hset(key, { since: String(nowMs) });
    await redis.expire(key, FLIGHT_CONFIG.DIVERGENCE_KEY_TTL_SECONDS);
  }

  const secondsOffCourse = Math.round((nowMs - since) / 1000);
  const sustained = secondsOffCourse >= FLIGHT_CONFIG.DIVERGENCE_ALERT_SECONDS;
  const canRealert = (nowMs - lastAlertedAt) / 1000 >= FLIGHT_CONFIG.DIVERGENCE_REALERT_SECONDS;
  const shouldAlert = sustained && canRealert;

  if (shouldAlert) {
    await redis.hset(key, { lastAlertedAt: String(nowMs) });
    await redis.expire(key, FLIGHT_CONFIG.DIVERGENCE_KEY_TTL_SECONDS);
  }

  return { seconds_off_course: secondsOffCourse, should_alert: shouldAlert };
}

export interface PositionCheckResult {
  safe: boolean;
  inside_safe_airspace: boolean;
  new_tfr_activated: boolean;
  tfr_name: string | null;
  current_weather: PositionWeather;
  remaining_minutes: number;
  on_course: boolean;             // NEW — heading within ON_COURSE_THRESHOLD of direct bearing
  closure_factor: number;         // NEW — cos(angle between heading and bearing-to-destination), 1 = directly closing, 0 = perpendicular, <0 = moving away
  seconds_off_course: number;     // NEW — how long closure_factor has been below LOW_CLOSURE_THRESHOLD, 0 if currently on course
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
  thresholds: WeatherThresholds = { max_wind_mph: 25, max_gust_mph: 35, max_precip: 2, min_visibility: 1000 },
  headingDeg?: number
): Promise<PositionCheckResult> {
  const groundSpeedKmh = groundSpeedMs * 3.6;
  const eta = estimateRemainingSeconds(current, destination, groundSpeedKmh, headingDeg);
  const remainingMinutes = Math.ceil(eta.seconds / 60);

  // Elevation has to resolve first — everything else needs altitudeMSL_ft.
  const elevationM = await getElevationAtPoint(current.lon, current.lat);
  const altitudeMSL_ft = altitudeAGL_ft + (elevationM * 3.28084);

  const horizonSeconds = Math.min(
    FLIGHT_CONFIG.HORIZON_MAX_SECONDS,
    Math.ceil(FLIGHT_CONFIG.HORIZON_MAX_DISTANCE_M / groundSpeedMs)
  );

  // FIX-PARALLEL: these four were previously sequential `await`s — none of
  // them depend on each other's results, only on altitudeMSL_ft computed
  // above, so they now run concurrently. Cuts wall-clock time from the sum
  // of all four round-trips down to roughly the slowest one.
  const [safeAirspaceCheck, currentWeather, immediateHorizonSafe, divergence] = await Promise.all([
    checkInsideSafeAirspace(current, flightSessionId, altitudeMSL_ft, sessionLimits),
    getWeatherAtPosition(current, altitudeMSL_ft, sessionLimits.ceiling, thresholds),
    checkImmediateHorizon(current, destination, altitudeMSL_ft, groundSpeedMs, horizonSeconds, thresholds, headingDeg),
    trackDivergence(flightSessionId, eta.closure_factor),
  ]);

  const insideSafe = safeAirspaceCheck.inside;
  const overallSafe = insideSafe && !currentWeather.restricted && immediateHorizonSafe;

  const restrictionState: RestrictionState = { windows: [], active: null };

  let alertPushed = false;
  if ((!overallSafe || divergence.should_alert) && monitorSessionId) {
    await pushAlert(monitorSessionId, {
      type: !overallSafe ? "position_check_alert" : "course_divergence_alert",
      inside_safe_airspace: insideSafe,
      new_tfr_activated: safeAirspaceCheck.new_tfr_hit,
      tfr_name: safeAirspaceCheck.tfr_name,
      current_weather: currentWeather,
      restricted: restrictionState,
      current_position: current,
      remaining_minutes: remainingMinutes,
      on_course: eta.on_course,
      closure_factor: Number(eta.closure_factor.toFixed(3)),
      seconds_off_course: divergence.seconds_off_course,
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
    on_course: eta.on_course,
    closure_factor: Number(eta.closure_factor.toFixed(3)),
    seconds_off_course: divergence.seconds_off_course,
    restricted: restrictionState,
    path_weather_safe: immediateHorizonSafe,
    alert_pushed: alertPushed,
  };
}
