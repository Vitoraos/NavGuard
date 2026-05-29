// backend/src/services/ruleService.ts
// Unified zone-first airspace engine with spatiotemporal weather matching.
//
// queryAirspace  — corridor-level safe/no-fly polygon + connectivity check
// queryWeatherTimeline — per-minute weather profile matched to drone position

import { pool } from "../config/db";

const WEATHER_CELL_RADIUS_M = 5000; // half of 0.1deg grid ≈ 5km cell radius

// ─── 1. Corridor-level airspace computation ───────────────────────────────────

export interface AirspaceResult {
  safe_airspace:   object | null;
  safe_fragments:  object | null;   // MultiPolygon pieces when disconnected
  corridor:        object;
  no_fly: {
    regulatory:    object | null;
    weather:       object | null;
  };
  restrictions:    object[];
  path_connected:  boolean;         // false → 422 in scanController
}

export async function queryAirspace(
  origin:       { lat: number; lon: number },
  destination:  { lat: number; lon: number },
  bufferMeters: number,
  floor:        number,
  ceil:         number,
  flightStart:  Date,
  flightEnd:    Date
): Promise<AirspaceResult> {

  const polylineGeoJSON = JSON.stringify({
    type: "LineString",
    coordinates: [
      [origin.lon, origin.lat],
      [destination.lon, destination.lat],
    ],
  });

  // Single unified query:
  // buf → tfr_zones → weather_zones → all_nofly → safe → connectivity check
  // All in one PostGIS round trip.

  const sql = `
WITH

-- 1. Flight corridor: buffered polyline
buf AS (
  SELECT ST_Transform(
    ST_Buffer(
      ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3857), $2
    ), 4326
  ) AS geom
),

-- 2. TFR / NFZ regulatory restrictions active during flight window
tfr_zones AS (
  SELECT ST_Union(geom) AS geom
  FROM nfz_zones
  WHERE altitude_ceiling >= $3
    AND altitude_floor   <= $4
    AND (start_time IS NULL OR (start_time <= $6 AND end_time >= $5))
    AND ST_Intersects(geom, (SELECT geom FROM buf))
),

-- 3. Weather restrictions during flight window
-- Uses restricted GENERATED column + partial index for speed
weather_zones AS (
  SELECT ST_Transform(
    ST_Buffer(ST_Collect(ST_Transform(geom, 3857)), $7), 4326
  ) AS geom
  FROM weather_grid
  WHERE restricted = true
    AND fetched_at >= $5
    AND fetched_at <= $6
    AND ST_Within(geom, (SELECT geom FROM buf))
),

-- 4. Combined no-fly: regulatory + weather
all_nofly AS (
  SELECT ST_Union(
    ARRAY_REMOVE(ARRAY[
      (SELECT geom FROM tfr_zones),
      (SELECT geom FROM weather_zones)
    ], NULL)
  ) AS geom
),

-- 5. Safe airspace: corridor minus all restrictions
safe AS (
  SELECT CASE
    WHEN (SELECT geom FROM all_nofly) IS NULL THEN (SELECT geom FROM buf)
    ELSE ST_Difference((SELECT geom FROM buf), (SELECT geom FROM all_nofly))
  END AS geom
),

-- 6. Connectivity check: are origin and destination in the same polygon piece?
-- ST_Dump explodes MultiPolygon into individual pieces.
-- If any single piece contains BOTH points → connected.
connectivity AS (
  SELECT COUNT(*) > 0 AS connected
  FROM (
    SELECT (ST_Dump(safe.geom)).geom AS part
    FROM safe
  ) pieces
  WHERE ST_DWithin(
    ST_Transform(pieces.part, 3857),
    ST_Transform(ST_SetSRID(ST_MakePoint($8, $9), 4326), 3857),
    500   -- 500m tolerance for origin
  )
  AND ST_DWithin(
    ST_Transform(pieces.part, 3857),
    ST_Transform(ST_SetSRID(ST_MakePoint($10, $11), 4326), 3857),
    500   -- 500m tolerance for destination
  )
)

SELECT
  ST_AsGeoJSON(safe.geom)                        AS safe_airspace,
  ST_AsGeoJSON(buf.geom)                         AS corridor,
  ST_AsGeoJSON((SELECT geom FROM tfr_zones))     AS tfr_no_fly,
  ST_AsGeoJSON((SELECT geom FROM weather_zones)) AS weather_no_fly,
  COALESCE((SELECT connected FROM connectivity), false) AS path_connected
FROM safe, buf`;

  // Individual restriction features with metadata (for response detail)
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
  AND (start_time IS NULL OR (start_time <= $6 AND end_time >= $5))
  AND geom && (SELECT geom FROM buf)
  AND ST_Intersects(geom, (SELECT geom FROM buf))`;

  const params = [
    polylineGeoJSON, bufferMeters, floor, ceil,
    flightStart.toISOString(), flightEnd.toISOString(),
    WEATHER_CELL_RADIUS_M,
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

  const safeAirspace  = row.safe_airspace  ? JSON.parse(row.safe_airspace)  : null;
  const pathConnected = row.path_connected as boolean;

  // When disconnected, return the individual fragments so the operator
  // can visualise where the gap is (included in 422 response)
  let safeFragments: object | null = null;
  if (!pathConnected && safeAirspace) {
    safeFragments = safeAirspace; // already a MultiPolygon from PostGIS
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

// ─── 2. Per-minute spatiotemporal weather timeline ────────────────────────────
//
// For each minute of the flight:
//   - Compute drone position using ST_LineInterpolatePoint
//   - Find nearest weather grid cell at that position
//   - Check weather at that cell specifically at that forecast hour
//
// This eliminates false positives: a cell that goes bad AFTER the drone
// has already passed through it no longer blocks the flight.

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

-- One row per minute of flight
time_steps AS (
  SELECT s AS t_offset_s
  FROM generate_series(0, $5::int, 60) AS s
),

-- Drone position + ETA at each minute
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

-- Spatiotemporal match: nearest cell at each minute at the right forecast hour
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
      -- Match forecast hour to drone ETA hour
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

  // Build minute-by-minute timeline
  const timeline: MinuteWeather[] = rows.map((r: any) => ({
    minute:     r.minute,
    eta:        r.eta,
    restricted: r.restricted,
    wind_mph:   parseFloat(r.wind_mph),
    precip:     parseFloat(r.precip),
    visibility: parseFloat(r.visibility),
    cell_id:    r.cell_id ?? null,
  }));

  // Collapse consecutive restricted minutes into windows
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

  // Close any open window at end of flight
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
