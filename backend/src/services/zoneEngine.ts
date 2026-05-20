// src/services/zoneEngine.ts
// Computes safe airspace and no-fly zones for a given bbox + drone thresholds.

import { pool } from "../config/db.js";

export interface DroneThresholds {
  max_wind_mph:   number;
  max_precip:     number;
  min_visibility: number;
}

export interface BBox {
  minLat: number; maxLat: number;
  minLon: number; maxLon: number;
}

export interface ViolatedPoint {
  id: number; lat: number; lon: number;
  wind_mph: number; precip: number; visibility: number;
  reasons: string[];
}

export interface ZoneComputeResult {
  safe_airspace:   object | null;
  no_fly_zones:    object[];
  violated_points: ViolatedPoint[];
}

export async function computeZones(bbox: BBox, t: DroneThresholds): Promise<ZoneComputeResult> {
  const { rows } = await pool.query<{
    id: number; lat: string; lon: string;
    wind_mph: string; precip: string; visibility: string;
  }>(`
    SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lon, wind_mph, precip, visibility
    FROM weather_grid
    WHERE ST_Within(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
    AND fetched_at > NOW() - INTERVAL '35 minutes'
  `, [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat]);

  const violated: ViolatedPoint[] = [];
  const violatedIds: number[] = [];

  for (const r of rows) {
    const wind = parseFloat(r.wind_mph);
    const prec = parseFloat(r.precip);
    const vis = parseFloat(r.visibility);
    const reasons: string[] = [];
    if (wind > t.max_wind_mph) reasons.push(`Wind ${wind.toFixed(1)} mph > ${t.max_wind_mph} mph limit`);
    if (prec > t.max_precip) reasons.push(`Precip ${prec.toFixed(2)} mm/hr > ${t.max_precip} mm/hr limit`);
    if (vis < t.min_visibility) reasons.push(`Visibility ${vis}m < ${t.min_visibility}m minimum`);
    if (reasons.length) {
      violated.push({ id: r.id, lat: parseFloat(r.lat), lon: parseFloat(r.lon), wind_mph: wind, precip: prec, visibility: vis, reasons });
      violatedIds.push(r.id);
    }
  }

  const { rows: geoRows } = await pool.query<{ safe_airspace: string | null; no_fly_union: string | null }>(`
    WITH bbox_geom AS (SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS geom),
    weather_bad AS (SELECT CASE WHEN $5::int[] = '{}' THEN NULL ELSE ST_Buffer(ST_Collect(geom)::geography, 5000)::geometry END AS geom FROM weather_grid WHERE id = ANY($5::int[])),
    nfz AS (SELECT ST_Union(geom) AS geom FROM nfz_zones WHERE ST_Intersects(geom, (SELECT geom FROM bbox_geom)) AND (end_time IS NULL OR end_time > NOW())),
    combined_nofly AS (SELECT ST_Union(ARRAY_REMOVE(ARRAY[(SELECT geom FROM weather_bad), (SELECT geom FROM nfz)], NULL)) AS geom),
    safe AS (SELECT CASE WHEN (SELECT geom FROM combined_nofly) IS NULL THEN (SELECT geom FROM bbox_geom) ELSE ST_Difference((SELECT geom FROM bbox_geom), (SELECT geom FROM combined_nofly)) END AS geom)
    SELECT ST_AsGeoJSON(safe.geom) AS safe_airspace, ST_AsGeoJSON(combined_nofly.geom) AS no_fly_union FROM safe, combined_nofly
  `, [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat, violatedIds]);

  const geo = geoRows[0];
  return {
    safe_airspace: geo?.safe_airspace ? JSON.parse(geo.safe_airspace) : null,
    no_fly_zones: geo?.no_fly_union ? [{ type: "Feature", geometry: JSON.parse(geo.no_fly_union), properties: { source: "combined", reason: "Weather violations + active NFZ zones" } }] : [],
    violated_points: violated,
  };
}