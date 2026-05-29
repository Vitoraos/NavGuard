#!/data/data/com.termux/files/usr/bin/bash

# -------------------------------------------------------------------
# NavGuard Fixes – FIX-01, FIX-02, FIX-03 + remove .js from imports
# Run this script from the root of your backend repository.
# -------------------------------------------------------------------

set -e  # exit on any error

echo ">>> Creating fixed files..."

# 1. src/services/monitorService.ts (FIX-01)
cat > src/services/monitorService.ts << 'EOF'
// src/services/monitorService.ts
// Holds active monitoring sessions in memory. Polls computeZones() every 5 min.

import { Response } from "express";
import { pool } from "../config/db.js";
import { computeZones, DroneThresholds, BBox } from "./zoneEngine.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface MonitorSession {
  id: string; bbox: BBox; thresholds: DroneThresholds;
  clients: Set<Response>; lastViolatedIds: Set<number>; timer: NodeJS.Timeout | null;
}

export const sessions = new Map<string, MonitorSession>();

export async function createSession(sessionId: string, bbox: BBox, thresholds: DroneThresholds): Promise<void> {
  if (sessions.has(sessionId)) return;
  const session: MonitorSession = { id: sessionId, bbox, thresholds, clients: new Set(), lastViolatedIds: new Set(), timer: null };
  sessions.set(sessionId, session);
  startPolling(session);
  console.log(`[monitor] Session created: ${sessionId}`);
}

export function registerClient(sessionId: string, res: Response): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.clients.add(res);
  console.log(`[monitor] Client connected — session: ${sessionId}, total clients: ${session.clients.size}`);
  res.on("close", () => { session.clients.delete(res); console.log(`[monitor] Client disconnected — session: ${sessionId}`); });
  return true;
}

export function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.timer) clearInterval(session.timer);
  sessions.delete(sessionId);
  console.log(`[monitor] Session destroyed: ${sessionId}`);
}

function startPolling(session: MonitorSession): void {
  runPoll(session);
  session.timer = setInterval(() => runPoll(session), POLL_INTERVAL_MS);
}

async function runPoll(session: MonitorSession): Promise<void> {
  if (session.clients.size === 0) return;
  try {
    const result = await computeZones(session.bbox, session.thresholds);
    const newViolatedIds = new Set(result.violated_points.map(v => v.id));
    const newViolations = result.violated_points.filter(v => !session.lastViolatedIds.has(v.id));
    const recoveredIds = [...session.lastViolatedIds].filter(id => !newViolatedIds.has(id));
    session.lastViolatedIds = newViolatedIds;
    const event = { type: "zone_update", timestamp: new Date().toISOString(), alert: newViolations.length > 0, new_violations: newViolations, recovered_ids: recoveredIds, safe_airspace: result.safe_airspace, no_fly_zones: result.no_fly_zones, violated_points: result.violated_points };
    broadcast(session, event);
    await pool.query(`UPDATE weather_monitor_sessions SET last_snapshot = $1 WHERE id = $2`, [JSON.stringify(event), session.id]);
    if (event.alert) console.log(`[monitor] ALERT on session ${session.id} — ${newViolations.length} new violation(s)`);
  } catch (err) { console.error(`[monitor] Poll error on session ${session.id}:`, err); }
}

export function broadcast(session: MonitorSession, data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of session.clients) { try { client.write(payload); } catch { session.clients.delete(client); } }
}
EOF

# 2. src/services/flightService.ts (FIX-01 + FIX-03)
cat > src/services/flightService.ts << 'EOF'
// backend/src/services/flightService.ts
// Stateless position check engine with dynamic TFR/NFZ re‑evaluation.

import { pool } from "../config/db.js";
import { queryWeatherTimeline } from "./ruleService.js";
import { broadcast, sessions } from "./monitorService.js";

function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const DRONE_SPEED_KMH  = 48;
const DURATION_BUFFER  = 1.5;
const MIN_DURATION_MIN = 5;
const MAX_DURATION_MIN = 120;

function estimateRemainingSeconds(
  current:     { lat: number; lon: number },
  destination: { lat: number; lon: number }
): number {
  const distKm     = haversineKm(current.lat, current.lon, destination.lat, destination.lon);
  const rawMinutes = (distKm / DRONE_SPEED_KMH) * 60 * DURATION_BUFFER;
  const minutes    = Math.max(MIN_DURATION_MIN, Math.min(MAX_DURATION_MIN, Math.ceil(rawMinutes)));
  return minutes * 60;
}

async function checkInsideSafeAirspace(
  current:       { lat: number; lon: number },
  flightSessionId: string
): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT ST_Within(
      ST_SetSRID(ST_MakePoint($1, $2), 4326),
      safe_airspace
    ) AS inside
    FROM flight_sessions
    WHERE id = $3
      AND safe_airspace IS NOT NULL
  `, [current.lon, current.lat, flightSessionId]);
  return rows[0]?.inside ?? true;
}

async function checkActiveRestrictionsAtPoint(
  lat: number,
  lon: number,
  altitude: number
): Promise<{ restricted: boolean; reasons: string[] }> {
  const { rows } = await pool.query(`
    SELECT name, type, reason
    FROM nfz_zones
    WHERE ST_Intersects(
      geom,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)
    )
    AND altitude_ceiling >= $3
    AND altitude_floor <= $4
    AND (start_time IS NULL OR start_time <= NOW())
    AND (end_time IS NULL OR end_time >= NOW())
    LIMIT 1
  `, [lon, lat, altitude, 0]);
  if (rows.length) {
    return {
      restricted: true,
      reasons: rows.map(r => `${r.type}: ${r.name} - ${r.reason || 'Active restriction'}`)
    };
  }
  return { restricted: false, reasons: [] };
}

interface PositionWeather {
  restricted:  boolean;
  wind_mph:    number;
  precip:      number;
  visibility:  number;
  reasons:     string[];
}

async function getWeatherAtPosition(
  current: { lat: number; lon: number }
): Promise<PositionWeather> {
  const { rows } = await pool.query(`
    SELECT
      restricted,
      wind_mph,
      precip,
      visibility
    FROM weather_grid
    WHERE
      date_trunc('hour', NOW() AT TIME ZONE 'UTC') =
      date_trunc('hour', fetched_at AT TIME ZONE 'UTC')
    ORDER BY
      ST_Distance(
        ST_Transform(geom, 3857),
        ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857)
      )
    LIMIT 1
  `, [current.lon, current.lat]);
  if (!rows.length) {
    return { restricted: false, wind_mph: 0, precip: 0, visibility: 9999, reasons: [] };
  }
  const r       = rows[0];
  const reasons: string[] = [];
  if (r.wind_mph > 25)    reasons.push(`Wind ${r.wind_mph.toFixed(1)} mph exceeds 25 mph limit`);
  if (r.precip > 2)       reasons.push(`Precipitation ${r.precip.toFixed(1)} mm/hr exceeds limit`);
  if (r.visibility < 1000)reasons.push(`Visibility ${r.visibility}m below 1000m minimum`);
  return {
    restricted:  r.restricted,
    wind_mph:    r.wind_mph,
    precip:      r.precip,
    visibility:  r.visibility,
    reasons,
  };
}

async function pushAlert(
  monitorSessionId: string,
  alert: object
): Promise<void> {
  await pool.query(`
    UPDATE weather_monitor_sessions
    SET last_snapshot = last_snapshot || $2::jsonb
    WHERE id = $1
  `, [monitorSessionId, JSON.stringify({ position_alert: alert, alerted_at: new Date().toISOString() })]);
  const session = sessions.get(monitorSessionId);
  if (session && session.clients.size > 0) {
    broadcast(session, {
      type: "position_alert",
      ...alert,
      alerted_at: new Date().toISOString()
    });
  }
}

export interface PositionCheckResult {
  safe:                   boolean;
  inside_safe_airspace:   boolean;
  current_weather:        PositionWeather;
  remaining_minutes:      number;
  restricted_windows:     object[];
  path_weather_safe:      boolean;
  alert_pushed:           boolean;
  active_restriction:     { restricted: boolean; reasons: string[] };
}

export async function checkDronePosition(
  flightSessionId:  string,
  monitorSessionId: string | null,
  current:          { lat: number; lon: number },
  destination:      { lat: number; lon: number },
  altitude:         number = 400
): Promise<PositionCheckResult> {
  const remainingSeconds = estimateRemainingSeconds(current, destination);
  const remainingMinutes = Math.ceil(remainingSeconds / 60);
  const [insideSafe, currentWeather, timeline, activeRestriction] = await Promise.all([
    checkInsideSafeAirspace(current, flightSessionId),
    getWeatherAtPosition(current),
    queryWeatherTimeline(current, destination, new Date(), remainingSeconds),
    checkActiveRestrictionsAtPoint(current.lat, current.lon, altitude)
  ]);
  const overallSafe = insideSafe &&
    !currentWeather.restricted &&
    timeline.path_weather_safe &&
    !activeRestriction.restricted;
  let alertPushed = false;
  if (!overallSafe && monitorSessionId) {
    await pushAlert(monitorSessionId, {
      type:                 "position_check_alert",
      inside_safe_airspace: insideSafe,
      current_weather:      currentWeather,
      restricted_windows:   timeline.restricted_windows,
      current_position:     current,
      remaining_minutes:    remainingMinutes,
      active_restriction:   activeRestriction
    });
    alertPushed = true;
  }
  return {
    safe:                 overallSafe,
    inside_safe_airspace: insideSafe,
    current_weather:      currentWeather,
    remaining_minutes:    remainingMinutes,
    restricted_windows:   timeline.restricted_windows,
    path_weather_safe:    timeline.path_weather_safe,
    alert_pushed:         alertPushed,
    active_restriction:   activeRestriction
  };
}
EOF

# 3. src/controllers/flightController.ts (FIX-03)
cat > src/controllers/flightController.ts << 'EOF'
import { Request, Response } from "express";
import { pool } from "../config/db.js";
import { checkDronePosition } from "../services/flightService.js";
import { isValidLatLon } from "../utils/validators.js";

export async function startFlight(req: Request, res: Response) {
  try {
    const {
      destination,
      altitude_ceiling,
      safe_airspace,
      monitor_session_id,
    } = req.body;
    if (!isValidLatLon(destination))
      return res.status(400).json({ error: "Invalid destination coordinates" });
    const apiKeyId = (req as any).apiKeyId;
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
    return res.status(201).json({
      flight_session_id: rows[0].id,
      expires_at:        rows[0].expires_at,
      message:           "Flight session started. Send GPS position to /api/flight/:id/position",
    });
  } catch (err: any) {
    console.error("startFlight error:", err);
    return res.status(500).json({ error: err.message });
  }
}

export async function updatePosition(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { lat, lon, altitude } = req.body;
    if (!lat || !lon || typeof lat !== "number" || typeof lon !== "number")
      return res.status(400).json({ error: "lat and lon required as numbers" });
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
      return res.status(404).json({ error: "Flight session not found" });
    const session = sessionRows[0];
    if (new Date(session.expires_at) < new Date())
      return res.status(410).json({ error: "Flight session expired" });
    const current     = { lat, lon };
    const destination = {
      lat: parseFloat(session.destination_lat),
      lon: parseFloat(session.destination_lon),
    };
    const result = await checkDronePosition(
      id,
      session.monitor_session_id,
      current,
      destination,
      altitude
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
  } catch (err: any) {
    console.error("updatePosition error:", err);
    return res.status(500).json({ error: err.message });
  }
}

export async function endFlight(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(`
      UPDATE public.flight_sessions
      SET expires_at = NOW()
      WHERE id = $1
    `, [id]);
    if (!rowCount)
      return res.status(404).json({ error: "Flight session not found" });
    return res.status(200).json({
      message:    "Flight session ended",
      landed_at:  new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("endFlight error:", err);
    return res.status(500).json({ error: err.message });
  }
}
EOF

# 4. src/services/ruleService.ts (FIX-02)
cat > src/services/ruleService.ts << 'EOF'
import { pool } from "../config/db.js";

const WEATHER_CELL_RADIUS_M = 5000;

export interface AirspaceResult {
  safe_airspace:   object | null;
  safe_fragments:  object | null;
  corridor:        object;
  no_fly: {
    regulatory:    object | null;
    weather:       object | null;
  };
  restrictions:    object[];
  path_connected:  boolean;
}

export interface AirspaceThresholds {
  max_wind_mph: number;
  max_precip: number;
  min_visibility: number;
}

export async function queryAirspace(
  origin:       { lat: number; lon: number },
  destination:  { lat: number; lon: number },
  bufferMeters: number,
  floor:        number,
  ceil:         number,
  flightStart:  Date,
  flightEnd:    Date,
  thresholds:   AirspaceThresholds
): Promise<AirspaceResult> {
  const polylineGeoJSON = JSON.stringify({
    type: "LineString",
    coordinates: [
      [origin.lon, origin.lat],
      [destination.lon, destination.lat],
    ],
  });
  const sql = `
WITH
buf AS (
  SELECT ST_Transform(
    ST_Buffer(
      ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3857), $2
    ), 4326
  ) AS geom
),
tfr_zones AS (
  SELECT ST_Union(geom) AS geom
  FROM nfz_zones
  WHERE altitude_ceiling >= $3
    AND altitude_floor   <= $4
    AND (start_time IS NULL OR (start_time <= $6 AND end_time >= $5))
    AND ST_Intersects(geom, (SELECT geom FROM buf))
),
weather_zones AS (
  SELECT ST_Transform(
    ST_Buffer(ST_Collect(ST_Transform(geom, 3857)), $7), 4326
  ) AS geom
  FROM weather_grid
  WHERE (wind_mph > $8 OR precip > $9 OR visibility < $10)
    AND fetched_at >= $5
    AND fetched_at <= $6
    AND ST_Within(geom, (SELECT geom FROM buf))
),
all_nofly AS (
  SELECT ST_Union(
    ARRAY_REMOVE(ARRAY[
      (SELECT geom FROM tfr_zones),
      (SELECT geom FROM weather_zones)
    ], NULL)
  ) AS geom
),
safe AS (
  SELECT CASE
    WHEN (SELECT geom FROM all_nofly) IS NULL THEN (SELECT geom FROM buf)
    ELSE ST_Difference((SELECT geom FROM buf), (SELECT geom FROM all_nofly))
  END AS geom
),
connectivity AS (
  SELECT COUNT(*) > 0 AS connected
  FROM (
    SELECT (ST_Dump(safe.geom)).geom AS part
    FROM safe
  ) pieces
  WHERE ST_DWithin(
    ST_Transform(pieces.part, 3857),
    ST_Transform(ST_SetSRID(ST_MakePoint($11, $12), 4326), 3857),
    500
  )
  AND ST_DWithin(
    ST_Transform(pieces.part, 3857),
    ST_Transform(ST_SetSRID(ST_MakePoint($13, $14), 4326), 3857),
    500
  )
)
SELECT
  ST_AsGeoJSON(safe.geom)                        AS safe_airspace,
  ST_AsGeoJSON(buf.geom)                         AS corridor,
  ST_AsGeoJSON((SELECT geom FROM tfr_zones))     AS tfr_no_fly,
  ST_AsGeoJSON((SELECT geom FROM weather_zones)) AS weather_no_fly,
  COALESCE((SELECT connected FROM connectivity), false) AS path_connected
FROM safe, buf`;
  const restrictionsSQL = `
WITH buf AS (
  SELECT ST_Transform(
    ST_Buffer(
      ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3857), $2
    ), 4326
  ) AS geom
)
SELECT id, name, reason, type, altitude_floor, altitude_ceiling,
       source, start_time, end_time,
       ST_AsGeoJSON(geom) AS geom_geojson
FROM nfz_zones
WHERE altitude_ceiling >= $3
  AND altitude_floor   <= $4
  AND (start_time IS NULL OR (start_time <= $6 AND (end_time IS NULL OR end_time >= $5)))
  AND geom && (SELECT geom FROM buf)
  AND ST_Intersects(geom, (SELECT geom FROM buf))`;
  const params = [
    polylineGeoJSON, bufferMeters, floor, ceil,
    flightStart.toISOString(), flightEnd.toISOString(),
    WEATHER_CELL_RADIUS_M,
    thresholds.max_wind_mph,
    thresholds.max_precip,
    thresholds.min_visibility,
    origin.lon, origin.lat,
    destination.lon, destination.lat,
  ];
  const restrictionParams = [
    polylineGeoJSON, bufferMeters, floor, ceil,
    flightStart.toISOString(), flightEnd.toISOString(),
  ];
  const [mainResult, restrictionsResult] = await Promise.all([
    pool.query(sql, params),
    pool.query(restrictionsSQL, restrictionParams),
  ]);
  const row = mainResult.rows[0];
  if (!row) {
    return {
      safe_airspace: null,
      safe_fragments: null,
      corridor: JSON.parse(JSON.stringify({ type: "LineString", coordinates: [[origin.lon, origin.lat], [destination.lon, destination.lat]] })),
      no_fly: { regulatory: null, weather: null },
      restrictions: [],
      path_connected: false,
    };
  }
  const safeAirspace  = row.safe_airspace ? JSON.parse(row.safe_airspace) : null;
  const pathConnected = row.path_connected as boolean;
  let safeFragments: object | null = null;
  if (!pathConnected && safeAirspace) {
    safeFragments = safeAirspace;
  }
  const restrictions = restrictionsResult.rows.map((r: any) => ({
    type: "Feature",
    geometry: JSON.parse(r.geom_geojson),
    properties: {
      id: r.id, name: r.name, reason: r.reason, type: r.type,
      altitude_floor: r.altitude_floor, altitude_ceiling: r.altitude_ceiling,
      source: r.source, start_time: r.start_time, end_time: r.end_time,
    },
  }));
  return {
    safe_airspace:  pathConnected ? safeAirspace : null,
    safe_fragments: safeFragments,
    corridor:       JSON.parse(row.corridor),
    no_fly: {
      regulatory: row.tfr_no_fly    ? JSON.parse(row.tfr_no_fly)    : null,
      weather:    row.weather_no_fly ? JSON.parse(row.weather_no_fly) : null,
    },
    restrictions,
    path_connected: pathConnected,
  };
}

export interface MinuteWeather {
  minute:     number;
  eta:        string;
  restricted: boolean;
  wind_mph:   number;
  precip:     number;
  visibility: number;
  cell_id:    number | null;
}

export interface RestrictedWindow {
  from_minute:    number;
  to_minute:      number;
  eta_start:      string;
  eta_end:        string;
  peak_wind:      number;
  peak_precip:    number;
  min_visibility: number;
}

export interface WeatherTimeline {
  path_weather_safe:  boolean;
  timeline:           MinuteWeather[];
  restricted_windows: RestrictedWindow[];
}

export async function queryWeatherTimeline(
  origin:          { lat: number; lon: number },
  destination:     { lat: number; lon: number },
  flightStart:     Date,
  durationSeconds: number
): Promise<WeatherTimeline> {
  const sql = `
WITH
flight_line AS (
  SELECT ST_SetSRID(
    ST_MakeLine(
      ST_MakePoint($1, $2),
      ST_MakePoint($3, $4)
    ), 4326
  ) AS geom
),
time_steps AS (
  SELECT s AS t_offset_s
  FROM generate_series(0, $5::int, 60) AS s
),
drone_positions AS (
  SELECT
    ts.t_offset_s,
    ($6::timestamptz + (ts.t_offset_s || ' seconds')::interval) AS eta,
    ST_LineInterpolatePoint(
      fl.geom,
      LEAST(1.0, ts.t_offset_s::float / GREATEST($5::float, 1))
    ) AS position
  FROM time_steps ts, flight_line fl
),
minute_weather AS (
  SELECT
    dp.t_offset_s,
    dp.eta,
    wg.cell_id,
    wg.restricted,
    wg.wind_mph,
    wg.precip,
    wg.visibility
  FROM drone_positions dp
  CROSS JOIN LATERAL (
    SELECT cell_id, restricted, wind_mph, precip, visibility
    FROM weather_grid wg
    WHERE
      ST_DWithin(
        ST_Transform(dp.position, 3857),
        ST_Transform(wg.geom, 3857),
        15000
      )
      AND date_trunc('hour', dp.eta AT TIME ZONE 'UTC') =
          date_trunc('hour', wg.fetched_at AT TIME ZONE 'UTC')
    ORDER BY ST_Distance(
      ST_Transform(dp.position, 3857),
      ST_Transform(wg.geom, 3857)
    )
    LIMIT 1
  ) wg
)
SELECT
  (t_offset_s / 60)::int       AS minute,
  eta,
  cell_id,
  COALESCE(restricted, false)  AS restricted,
  COALESCE(wind_mph,   0)      AS wind_mph,
  COALESCE(precip,     0)      AS precip,
  COALESCE(visibility, 9999)   AS visibility
FROM minute_weather
ORDER BY t_offset_s`;
  const { rows } = await pool.query(sql, [
    origin.lon, origin.lat,
    destination.lon, destination.lat,
    durationSeconds,
    flightStart.toISOString(),
  ]);
  const timeline: MinuteWeather[] = rows.map((r: any) => ({
    minute:     r.minute,
    eta:        r.eta,
    restricted: r.restricted,
    wind_mph:   parseFloat(r.wind_mph),
    precip:     parseFloat(r.precip),
    visibility: parseFloat(r.visibility),
    cell_id:    r.cell_id ?? null,
  }));
  const restricted_windows: RestrictedWindow[] = [];
  let windowStart: MinuteWeather | null = null;
  let windowRows:  MinuteWeather[]      = [];
  for (const row of timeline) {
    if (row.restricted) {
      if (!windowStart) { windowStart = row; windowRows = []; }
      windowRows.push(row);
    } else if (windowStart) {
      const last = windowRows[windowRows.length - 1];
      restricted_windows.push({
        from_minute:    windowStart.minute,
        to_minute:      last.minute,
        eta_start:      windowStart.eta,
        eta_end:        last.eta,
        peak_wind:      Math.max(...windowRows.map(r => r.wind_mph)),
        peak_precip:    Math.max(...windowRows.map(r => r.precip)),
        min_visibility: Math.min(...windowRows.map(r => r.visibility)),
      });
      windowStart = null;
      windowRows  = [];
    }
  }
  if (windowStart && windowRows.length) {
    const last = windowRows[windowRows.length - 1];
    restricted_windows.push({
      from_minute:    windowStart.minute,
      to_minute:      last.minute,
      eta_start:      windowStart.eta,
      eta_end:        last.eta,
      peak_wind:      Math.max(...windowRows.map(r => r.wind_mph)),
      peak_precip:    Math.max(...windowRows.map(r => r.precip)),
      min_visibility: Math.min(...windowRows.map(r => r.visibility)),
    });
  }
  return {
    path_weather_safe:  restricted_windows.length === 0,
    timeline,
    restricted_windows,
  };
}
EOF

# 5. src/controllers/scanController.ts (FIX-02)
cat > src/controllers/scanController.ts << 'EOF'
import { Request, Response } from "express";
import { queryAirspace, queryWeatherTimeline } from "../services/ruleService.js";
import { getWeatherFreshness } from "../services/weatherService.js";
import { isValidLatLon, isValidAltitude, isValidBuffer } from "../utils/validators.js";
import { parseFlightTime } from "../utils/time.js";
import { pool } from "../config/db.js";

const DRONE_SPEED_KMH  = 48;
const DURATION_BUFFER  = 1.5;
const MIN_DURATION_MIN = 15;
const MAX_DURATION_MIN = 120;

function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function estimateFlightMinutes(
  origin:      { lat: number; lon: number },
  destination: { lat: number; lon: number }
): number {
  const distKm     = haversineKm(origin.lat, origin.lon, destination.lat, destination.lon);
  const rawMinutes = (distKm / DRONE_SPEED_KMH) * 60 * DURATION_BUFFER;
  return Math.max(
    MIN_DURATION_MIN,
    Math.min(MAX_DURATION_MIN, Math.ceil(rawMinutes))
  );
}

export async function scanHandler(req: Request, res: Response) {
  try {
    const {
      origin, destination,
      buffer_km, altitude_floor, altitude_ceiling,
      start_time,
      thresholds,
    } = req.body;
    const includeTimeline = req.query.include_timeline === "true";
    if (!isValidLatLon(origin) || !isValidLatLon(destination))
      return res.status(400).json({ error: "Invalid coordinates" });
    const floor = Number(altitude_floor ?? 0);
    const ceil  = Number(altitude_ceiling ?? 400);
    if (!isValidAltitude(floor, ceil))
      return res.status(400).json({ error: "Invalid altitude range" });
    const bufferMeters = Math.min(Math.max(Number(buffer_km ?? 10), 1), 50) * 1000;
    if (!isValidBuffer(bufferMeters))
      return res.status(400).json({ error: "Invalid buffer size" });
    const flightStart = parseFlightTime(start_time);
    if (!flightStart)
      return res.status(400).json({ error: "Invalid ISO 8601 start_time" });
    const estimatedMinutes  = estimateFlightMinutes(origin, destination);
    const estimatedSeconds  = estimatedMinutes * 60;
    const flightEnd         = new Date(
      flightStart.getTime() + estimatedMinutes * 60 * 1000
    );
    const { rows: tfrRows } = await pool.query(
      "SELECT MAX(last_synced) AS synced FROM nfz_zones"
    );
    const tfrLastSynced = tfrRows[0]?.synced;
    const tfrStale = !tfrLastSynced ||
      Date.now() - new Date(tfrLastSynced).getTime() > 15 * 60 * 1000;
    if (tfrStale) {
      return res.status(503).json({
        error:       "airspace_data_stale",
        last_synced: tfrLastSynced ?? null,
        message:     "TFR data older than 15 minutes. Do not use for active flight planning.",
      });
    }
    const weatherFreshness = await getWeatherFreshness();
    const weatherThresholds = {
      max_wind_mph: thresholds?.max_wind_mph ?? 25,
      max_precip:   thresholds?.max_precip ?? 2,
      min_visibility: thresholds?.min_visibility ?? 1000
    };
    const [airspace, weatherTimeline] = await Promise.all([
      queryAirspace(
        origin, destination,
        bufferMeters, floor, ceil,
        flightStart, flightEnd,
        weatherThresholds
      ),
      queryWeatherTimeline(
        origin, destination,
        flightStart, estimatedSeconds
      ),
    ]);
    const flightWindow = {
      start:             flightStart.toISOString(),
      end:               flightEnd.toISOString(),
      estimated_minutes: estimatedMinutes,
    };
    if (!airspace.path_connected) {
      return res.status(422).json({
        error:  "flight_path_blocked",
        reason: "Airspace or weather restriction creates disconnected safe space. No flyable path exists between origin and destination.",
        restricted_windows: weatherTimeline.restricted_windows,
        safe_fragments:     airspace.safe_fragments,
        corridor:           airspace.corridor,
        no_fly: {
          regulatory: airspace.no_fly.regulatory,
          weather:    airspace.no_fly.weather,
        },
        flight_window: flightWindow,
        weather: {
          data_freshness: weatherFreshness.last_synced,
          stale:          weatherFreshness.stale,
          stale_minutes:  weatherFreshness.stale_minutes,
        },
        data: {
          tfr_last_synced: tfrLastSynced,
        },
      });
    }
    return res.status(200).json({
      safe_airspace: airspace.safe_airspace,
      corridor: airspace.corridor,
      no_fly: {
        regulatory: airspace.no_fly.regulatory,
        weather:    airspace.no_fly.weather,
      },
      restrictions: airspace.restrictions,
      path_connected: true,
      has_weather_warning:  weatherTimeline.restricted_windows.length > 0,
      restricted_windows:   weatherTimeline.restricted_windows,
      ...(includeTimeline && { timeline: weatherTimeline.timeline }),
      flight_window: flightWindow,
      weather: {
        data_freshness: weatherFreshness.last_synced,
        stale:          weatherFreshness.stale,
        stale_minutes:  weatherFreshness.stale_minutes,
      },
      data: {
        tfr_last_synced: tfrLastSynced,
      },
    });
  } catch (err: any) {
    console.error("Scan error:", err);
    return res.status(500).json({ error: err.message });
  }
}
EOF

echo ">>> Fixed files written."

# -------------------------------------------------------------------
# Remove .js extensions from import statements in all .ts files
# -------------------------------------------------------------------
echo ">>> Removing '.js' extensions from imports in all .ts files..."

# Find all .ts files (excluding node_modules and dist)
find src scripts -name "*.ts" -type f | while read -r file; do
  # Replace 'from "./something.js"' with 'from "./something"'
  # Also replace 'from "../something.js"' etc.
  sed -i 's/from "\([^"]*\)\.js"/from "\1"/g' "$file"
  echo "Processed: $file"
done

echo ">>> Import extensions removed."

# -------------------------------------------------------------------
# Git commit
# -------------------------------------------------------------------
echo ">>> Staging changes and committing..."

git add -A
git commit -m "Fix P0 issues: real-time alerts, threshold split, dynamic TFR checks

- FIX-01: pushAlert now broadcasts live via monitorService
- FIX-02: queryAirspace accepts per-flight weather thresholds
- FIX-03: active restriction check on every position update
- Removed .js extensions from imports to fix module resolution"

echo ">>> All done. You can now run 'git log -1' to see the commit."
