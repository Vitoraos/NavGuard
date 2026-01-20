import { pool } from "../config/db";
import { Feature, Polygon } from "geojson";

export async function queryRules(
  buffer: Feature<Polygon>,
  floor: number,
  ceil: number,
  flightStart: Date
) {
  const bufferText = JSON.stringify(buffer);

  const sql = `
WITH buf AS (
  SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geom
)
SELECT id, name, reason, altitude_floor, altitude_ceiling, source,
       start_time, end_time,
       ST_AsGeoJSON(geom) AS geom_geojson
FROM nfz_zones
WHERE altitude_ceiling >= $2
  AND altitude_floor <= $3
  AND (
        start_time IS NULL
        OR (start_time <= $4 AND end_time >= $4)
        OR start_time >= $4
      )
  AND ST_Intersects(geom, (SELECT geom FROM buf));
`;

  const params = [bufferText, floor, ceil, flightStart.toISOString()];
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
      end_time: r.end_time
    }
  }));
}
