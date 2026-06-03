import { pool } from "../config/db";

function selectBand(altitudeFt: number): string {
  if (altitudeFt < 2500) return "surface";
  if (altitudeFt < 5000) return "925hPa";
  return "850hPa";
}

const WEATHER_CELL_RADIUS_M = 5000;

export interface AirspaceResult {
  safe_airspace: object | null;
  safe_fragments: object | null;
  corridor: object;
  no_fly: { regulatory: object | null; weather: object | null };
  restrictions: object[];
  path_connected: boolean;
}

export interface AirspaceThresholds {
  max_wind_mph: number;
  max_precip: number;
  min_visibility: number;
}

export async function queryAirspace(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  bufferMeters: number,
  floor: number,
  ceil: number,
  flightStart: Date,
  flightEnd: Date,
  thresholds: AirspaceThresholds
): Promise<AirspaceResult> {
  const polylineGeoJSON = JSON.stringify({
    type: "LineString",
    coordinates: [[origin.lon, origin.lat], [destination.lon, destination.lat]],
  });

  const sql = `
    WITH buf AS (
      SELECT ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)::geometry AS geom
    ),
    tfr_zones AS (
      SELECT ST_Union(geom) AS geom
      FROM nfz_zones
      WHERE altitude_ceiling >= $3
        AND altitude_floor <= $4
        AND (start_time IS NULL OR (start_time <= $6 AND (end_time IS NULL OR end_time >= $5)))
        AND ST_Intersects(geom, (SELECT geom FROM buf))
    ),
    weather_zones AS (
      SELECT ST_Buffer(ST_Collect(geom)::geography, $7)::geometry AS geom
      FROM weather_grid
      WHERE (wind_mph > $8 OR precip > $9 OR visibility < $10)
        AND altitude_band = $11
        AND fetched_at > NOW() - INTERVAL '40 minutes'
        AND forecast_time >= date_trunc('hour', $5::timestamptz)
        AND forecast_time <= date_trunc('hour', $6::timestamptz)
        AND ST_Within(geom, (SELECT geom FROM buf))
    ),
    all_nofly AS (
      SELECT ST_Union(ARRAY_REMOVE(ARRAY[(SELECT geom FROM tfr_zones), (SELECT geom FROM weather_zones)], NULL)) AS geom
    ),
    safe AS (
      SELECT CASE
        WHEN (SELECT geom FROM all_nofly) IS NULL THEN (SELECT geom FROM buf)
        ELSE ST_Difference((SELECT geom FROM buf), (SELECT geom FROM all_nofly))
      END AS geom
    ),
    connectivity AS (
      SELECT COUNT(*) > 0 AS connected
      FROM (SELECT (ST_Dump(safe.geom)).geom AS part FROM safe) pieces
      WHERE ST_DWithin(pieces.part::geography, ST_SetSRID(ST_MakePoint($12, $13), 4326)::geography, 500)
        AND ST_DWithin(pieces.part::geography, ST_SetSRID(ST_MakePoint($14, $15), 4326)::geography, 500)
    )
    SELECT
      ST_AsGeoJSON(safe.geom) AS safe_airspace,
      ST_AsGeoJSON(buf.geom) AS corridor,
      ST_AsGeoJSON((SELECT geom FROM tfr_zones)) AS tfr_no_fly,
      ST_AsGeoJSON((SELECT geom FROM weather_zones)) AS weather_no_fly,
      COALESCE((SELECT connected FROM connectivity), false) AS path_connected
    FROM safe, buf
  `;

  const restrictionsSQL = `
    WITH buf AS (
      SELECT ST_Buffer(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography, $2)::geometry AS geom
    )
    SELECT id, name, reason, type, altitude_floor, altitude_ceiling, source, start_time, end_time, ST_AsGeoJSON(geom) AS geom_geojson
    FROM nfz_zones
    WHERE altitude_ceiling >= $3
      AND altitude_floor <= $4
      AND (start_time IS NULL OR (start_time <= $6 AND (end_time IS NULL OR end_time >= $5)))
      AND geom && (SELECT geom FROM buf)
      AND ST_Intersects(geom, (SELECT geom FROM buf))
  `;

  const params = [
    polylineGeoJSON,
    bufferMeters,
    floor,
    ceil,
    flightStart.toISOString(),
    flightEnd.toISOString(),
    WEATHER_CELL_RADIUS_M,
    thresholds.max_wind_mph,
    thresholds.max_precip,
    thresholds.min_visibility,
    selectBand(ceil),
    origin.lon,
    origin.lat,
    destination.lon,
    destination.lat,
  ];

  const restrictionParams = [
    polylineGeoJSON,
    bufferMeters,
    floor,
    ceil,
    flightStart.toISOString(),
    flightEnd.toISOString(),
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
      corridor: { type: "LineString", coordinates: [[origin.lon, origin.lat], [destination.lon, destination.lat]] },
      no_fly: { regulatory: null, weather: null },
      restrictions: [],
      path_connected: false,
    };
  }

  const safeAirspace = row.safe_airspace ? JSON.parse(row.safe_airspace) : null;
  const pathConnected = row.path_connected as boolean;
  const safeFragments = !pathConnected && safeAirspace ? safeAirspace : null;

  const restrictions = restrictionsResult.rows.map((r: any) => ({
    type: "Feature",
    geometry: JSON.parse(r.geom_geojson),
    properties: {
      id: r.id,
      name: r.name,
      reason: r.reason,
      type: r.type,
      altitude_floor: r.altitude_floor,
      altitude_ceiling: r.altitude_ceiling,
      source: r.source,
      start_time: r.start_time,
      end_time: r.end_time,
    },
  }));

  return {
    safe_airspace: pathConnected ? safeAirspace : null,
    safe_fragments: safeFragments,
    corridor: JSON.parse(row.corridor),
    no_fly: {
      regulatory: row.tfr_no_fly ? JSON.parse(row.tfr_no_fly) : null,
      weather: row.weather_no_fly ? JSON.parse(row.weather_no_fly) : null,
    },
    restrictions,
    path_connected: pathConnected,
  };
}

// FIX-04: null = no data coverage, never treat as safe
export type WeatherRestricted = boolean | null;

export interface MinuteWeather {
  minute: number;
  eta: string;
  restricted: WeatherRestricted;
  data_unavailable: boolean;
  wind_mph: number;
  precip: number;
  visibility: number;
  cell_id: number | null;
}

export interface RestrictedWindow {
  from_minute: number;
  to_minute: number;
  eta_start: string;
  eta_end: string;
  peak_wind: number;
  peak_precip: number;
  min_visibility: number;
}

export interface WeatherTimeline {
  path_weather_safe: boolean;
  data_gaps: boolean;
  timeline: MinuteWeather[];
  restricted_windows: RestrictedWindow[];
}

export async function queryWeatherTimeline(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  flightStart: Date,
  durationSeconds: number,
  altitudeCeiling: number = 400
): Promise<WeatherTimeline> {
  // OPTIMIZED: Uses date_trunc to snap ETA to the exact forecast hour bucket.
  // Eliminates the expensive correlated subquery and allows direct B-tree index hits.
  const sql = `
    WITH flight_line AS (
      SELECT ST_SetSRID(ST_MakeLine(ST_MakePoint($1, $2), ST_MakePoint($3, $4)), 4326) AS geom
    ),
    time_steps AS (
      SELECT s AS t_offset_s FROM generate_series(0, $5::int, 60) AS s
    ),
    drone_positions AS (
      SELECT
        ts.t_offset_s,
        ($6::timestamptz + (ts.t_offset_s || ' seconds')::interval) AS eta,
        ST_LineInterpolatePoint(fl.geom, LEAST(1.0, ts.t_offset_s::float / GREATEST($5::float, 1))) AS position
      FROM time_steps ts, flight_line fl
    ),
    minute_weather AS (
      SELECT dp.t_offset_s, dp.eta, wg.cell_id, wg.restricted, wg.wind_mph, wg.precip, wg.visibility
      FROM drone_positions dp
      CROSS JOIN LATERAL (
        SELECT cell_id, restricted, wind_mph, precip, visibility
        FROM weather_grid wg
        WHERE ST_DWithin(wg.geom::geography, dp.position::geography, 15000)
          AND wg.altitude_band = $7
          AND wg.fetched_at > NOW() - INTERVAL '40 minutes'
          AND wg.forecast_time = date_trunc('hour', dp.eta)
        ORDER BY ST_Distance(wg.geom::geography, dp.position::geography)
        LIMIT 1
      ) wg
    )
    SELECT
      (t_offset_s / 60)::int AS minute,
      eta,
      cell_id,
      COALESCE(restricted, NULL) AS restricted,
      COALESCE(wind_mph, 0) AS wind_mph,
      COALESCE(precip, 0) AS precip,
      COALESCE(visibility, 9999) AS visibility
    FROM minute_weather
    ORDER BY t_offset_s
  `;

  const { rows } = await pool.query(sql, [
    origin.lon,
    origin.lat,
    destination.lon,
    destination.lat,
    durationSeconds,
    flightStart.toISOString(),
    selectBand(altitudeCeiling),
  ]);

  let dataGaps = false;
  const timeline: MinuteWeather[] = rows.map((r: any) => {
    const unavailable = r.restricted === null;
    if (unavailable) dataGaps = true;
    return {
      minute: r.minute,
      eta: r.eta,
      restricted: unavailable ? null : r.restricted,
      data_unavailable: unavailable,
      wind_mph: parseFloat(r.wind_mph),
      precip: parseFloat(r.precip),
      visibility: parseFloat(r.visibility),
      cell_id: r.cell_id ?? null,
    };
  });

  const restricted_windows: RestrictedWindow[] = [];
  let windowStart: MinuteWeather | null = null;
  let windowRows: MinuteWeather[] = [];

  for (const row of timeline) {
    const isRestricted = row.restricted === true || row.data_unavailable;
    if (isRestricted) {
      if (!windowStart) {
        windowStart = row;
        windowRows = [];
      }
      windowRows.push(row);
    } else if (windowStart) {
      const last = windowRows[windowRows.length - 1];
      restricted_windows.push({
        from_minute: windowStart.minute,
        to_minute: last.minute,
        eta_start: windowStart.eta,
        eta_end: last.eta,
        peak_wind: Math.max(...windowRows.map((r) => r.wind_mph)),
        peak_precip: Math.max(...windowRows.map((r) => r.precip)),
        min_visibility: Math.min(...windowRows.map((r) => r.visibility)),
      });
      windowStart = null;
      windowRows = [];
    }
  }

  if (windowStart && windowRows.length) {
    const last = windowRows[windowRows.length - 1];
    restricted_windows.push({
      from_minute: windowStart.minute,
      to_minute: last.minute,
      eta_start: windowStart.eta,
      eta_end: last.eta,
      peak_wind: Math.max(...windowRows.map((r) => r.wind_mph)),
      peak_precip: Math.max(...windowRows.map((r) => r.precip)),
      min_visibility: Math.min(...windowRows.map((r) => r.visibility)),
    });
  }

  return {
    path_weather_safe: restricted_windows.length === 0,
    data_gaps: dataGaps,
    timeline,
    restricted_windows,
  };
}
