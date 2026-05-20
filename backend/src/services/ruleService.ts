import { pool } from "../config/db.js";

export async function queryAirspace(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  bufferMeters: number,
  floor: number,
  ceil: number,
  flightStart: Date
) {
  const polylineGeoJSON = JSON.stringify({
    type: "LineString",
    coordinates: [
      [origin.lon, origin.lat],
      [destination.lon, destination.lat],
    ],
  });

  const params = [
    polylineGeoJSON,
    bufferMeters,
    floor,
    ceil,
    flightStart.toISOString(),
  ];

  const safeSQL = `
WITH buf AS (
  SELECT ST_Transform(
    ST_Buffer(
      ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326), 3857), $2
    ), 4326
  ) AS geom
),
restrictions AS (
  SELECT ST_Union(geom) AS geom
  FROM nfz_zones
  WHERE altitude_ceiling >= $3
    AND altitude_floor   <= $4
    AND (start_time IS NULL OR (start_time <= $5 AND end_time >= $5))
    AND ST_Intersects(geom, (SELECT geom FROM buf))
),
safe AS (
  SELECT CASE
    WHEN (SELECT geom FROM restrictions) IS NULL
    THEN (SELECT geom FROM buf)
    ELSE ST_Difference((SELECT geom FROM buf), (SELECT geom FROM restrictions))
  END AS geom
)
SELECT
  ST_AsGeoJSON(safe.geom) AS safe_airspace,
  ST_AsGeoJSON(buf.geom)  AS corridor
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
       source, start_time, end_time, ST_AsGeoJSON(geom) AS geom_geojson
FROM nfz_zones
WHERE altitude_ceiling >= $3
  AND altitude_floor   <= $4
  AND (start_time IS NULL OR (start_time <= $5 AND end_time >= $5))
  AND geom && (SELECT geom FROM buf)
  AND ST_Intersects(geom, (SELECT geom FROM buf))`;

  const [safeResult, restrictionsResult] = await Promise.all([
    pool.query(safeSQL, params),
    pool.query(restrictionsSQL, params),
  ]);

  const safe = safeResult.rows[0];

  const restrictions = restrictionsResult.rows.map((r: any) => ({
    type: "Feature",
    geometry: JSON.parse(r.geom_geojson),
    properties: {
      id:               r.id,
      name:             r.name,
      reason:           r.reason,
      type:             r.type,
      altitude_floor:   r.altitude_floor,
      altitude_ceiling: r.altitude_ceiling,
      source:           r.source,
      start_time:       r.start_time,
      end_time:         r.end_time,
    },
  }));

  return {
    safe_airspace: safe.safe_airspace ? JSON.parse(safe.safe_airspace) : null,
    corridor:      JSON.parse(safe.corridor),
    restrictions,
  };
}