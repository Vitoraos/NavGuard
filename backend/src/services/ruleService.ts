import { pool } from "../config/db";
import { Feature, Polygon } from "geojson";

/**
 * Query NFZ/TFR rules for a flight path.
 * The buffer is applied inside SQL, so Node doesn't need to compute it.
 */
export async function queryRules(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number },
  bufferMeters: number,
  floor: number,
  ceil: number,
  flightStart: Date
) {
  // Convert polyline to GeoJSON LineString
  const polylineGeoJSON = JSON.stringify({
    type: "LineString",
    coordinates: [
      [origin.lon, origin.lat],
      [destination.lon, destination.lat],
    ],
  });

  const sql = `
WITH buf AS (
  SELECT ST_Transform(
           ST_Buffer(
             ST_Transform(
               ST_SetSRID(ST_GeomFromGeoJSON($1), 4326),
               3857
             ),
             $2
           ),
           4326
         ) AS geom
)
SELECT id, name, reason, altitude_floor, altitude_ceiling, source,
       start_time, end_time,
       ST_AsGeoJSON(geom) AS geom_geojson
FROM nfz_zones
WHERE altitude_ceiling >= $3
  AND altitude_floor <= $4
  AND (
        start_time IS NULL
        OR (start_time <= $5 AND end_time >= $5)
        OR start_time >= $5
      )
  AND geom && (SELECT geom FROM buf)
  AND ST_Intersects(geom, (SELECT geom FROM buf));
`;

  const params = [polylineGeoJSON, bufferMeters, floor, ceil, flightStart.toISOString()];
  const { rows } = await pool.query(sql, params);

  return rows.map((r: any) => ({
    type: "Feature",
    geometry: JSON.parse(r.geom_geojson),
    properties: {
      id: r.id,
      name: r.name,
      reason: r.reason,
      altitude_floor: r.altitude_floor,
      altitude_ceiling: r.altitude_ceiling,
      source: r.source,
      start_time: r.start_time,
      end_time: r.end_time,
    },
  }));
}
