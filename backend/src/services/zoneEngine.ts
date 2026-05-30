import { pool } from "../config/db";

export async function computeZones(bbox: any, thresholds: any) {
  // First query (violated points)
  const violatedPointsSQL = `
    SELECT id, geom 
    FROM weather_grid 
    WHERE (wind_mph > $1 OR precip > $2 OR visibility < $3) 
    AND altitude_band = 'surface' -- BUG-01: monitor sessions default to surface band
    AND fetched_at > NOW() - INTERVAL '40 minutes'
    AND ST_Within(geom, ST_MakeEnvelope($4, $5, $6, $7, 4326))
  `;
  
  const { rows: violated } = await pool.query(violatedPointsSQL, [
    thresholds.max_wind_mph,
    thresholds.max_precip,
    thresholds.min_visibility,
    bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat
  ]);

  // Second query (weather_bad CTE)
  const weatherBadSQL = `
    WITH weather_bad AS (
      SELECT ST_Collect(geom) as geom
      FROM weather_grid
      WHERE (wind_mph > $1 OR precip > $2 OR visibility < $3)
      AND altitude_band = 'surface' -- BUG-01: monitor sessions default to surface band
      AND fetched_at > NOW() - INTERVAL '40 minutes'
      AND ST_Within(geom, ST_MakeEnvelope($4, $5, $6, $7, 4326))
    )
    SELECT ST_AsGeoJSON(geom) as bad_zone FROM weather_bad
  `;

  const { rows: badZones } = await pool.query(weatherBadSQL, [
    thresholds.max_wind_mph,
    thresholds.max_precip,
    thresholds.min_visibility,
    bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat
  ]);

  return {
    violated_points: violated,
    bad_zones: badZones[0]?.bad_zone ? JSON.parse(badZones[0].bad_zone) : null
  };
}
