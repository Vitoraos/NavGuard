// src/services/zoneEngine.ts
// Computes safe airspace and no-fly zones for a given bbox + drone thresholds.
import { pool } from "../config/db";

// FIX-3D-VOLUME: previously this file had no altitude parameter at all and
// hardcoded `altitude_band = 'surface'` in both queries below — meaning the
// /api/zones endpoint (and its periodic re-poll in monitorService.ts) were
// always evaluating a 2D surface slice no matter what altitude the caller
// cared about. Now takes altitudeFloor/altitudeCeiling and selects the band
// the same way ruleService.ts/flightService.ts already do for the
// flight-planning and in-flight-check paths, so all three are consistent.
function selectBand(altitudeCeilingFt: number): string {
  if (altitudeCeilingFt < 2500) return "surface";
  if (altitudeCeilingFt < 5000) return "925hPa";
  return "850hPa";
}

// FIX-NFZ-STALE: mirrors the 15-minute threshold /scan already enforces via
// its own tfrStale check (scanController.ts). computeZones runs both on
// every initial POST /zones call AND on every 5-minute re-poll tick inside
// monitorService.ts, forever, for the lifetime of a session. Without this,
// a dead/broken syncTFRs.ts job means the live SSE stream keeps confidently
// broadcasting zone_update events that silently omit any TFR that appeared,
// changed, or expired since the last successful sync — exactly the kind of
// stale-data-treated-as-current failure the weather side of this same query
// already guards against (see the `fetched_at > NOW() - INTERVAL '40
// minutes'` filter below), but the NFZ side never had an equivalent check
// until now. Kept as one named constant so this can't silently drift out of
// sync with /scan's threshold.
const NFZ_STALE_MINUTES = 15;

export interface DroneThresholds {
  max_wind_mph:   number;
  max_gust_mph:   number; // FIX-GUST
  max_precip:     number;
  min_visibility: number;
}

export interface BBox {
  minLat: number; maxLat: number;
  minLon: number; maxLon: number;
}

export interface ViolatedPoint {
  id: number; lat: number; lon: number;
  wind_mph: number; gust_mph: number | null; precip: number; visibility: number;
  reasons: string[];
}

export interface ZoneComputeResult {
  safe_airspace:   object | null;
  no_fly_zones:    object[];
  violated_points: ViolatedPoint[];
  altitude_band:   string; // NEW — surfaced so callers/UI know which band this was computed against
  nfz_stale:       boolean;       // NEW — true if nfz_zones hasn't synced recently; caller decides whether to trust this event for routing
  nfz_last_synced: string | null; // NEW — ISO timestamp of the most recent successful NFZ/TFR sync, or null if the table has never synced
}

export async function computeZones(
  bbox: BBox,
  t: DroneThresholds,
  altitudeFloor: number = 0,
  altitudeCeiling: number = 400
): Promise<ZoneComputeResult> {
  const band = selectBand(altitudeCeiling);

  // FIX-NFZ-STALE: run the weather-grid query and the NFZ freshness check
  // in parallel — they're independent reads and there's no reason to pay
  // the latency of them sequentially on every poll tick.
  const [{ rows }, { rows: syncRows }] = await Promise.all([
    pool.query<{
      id: number; lat: string; lon: string;
      wind_mph: string; gust_mph: string | null; precip: string; visibility: string;
    }>(`
      SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lon, wind_mph, gust_mph, precip, visibility
      FROM weather_grid
      WHERE ST_Within(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
        AND fetched_at > NOW() - INTERVAL '40 minutes'
        AND altitude_band = $5
    `, [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat, band]),
    pool.query<{ synced: string | null }>(`SELECT MAX(last_synced) AS synced FROM nfz_zones`),
  ]);

  const nfzLastSynced = syncRows[0]?.synced ?? null;
  const nfzStale = !nfzLastSynced ||
    Date.now() - new Date(nfzLastSynced).getTime() > NFZ_STALE_MINUTES * 60 * 1000;

  const violated: ViolatedPoint[] = [];
  const violatedIds: number[] = [];

  for (const r of rows) {
    const wind = parseFloat(r.wind_mph);
    const gust = r.gust_mph !== null && r.gust_mph !== undefined ? parseFloat(r.gust_mph) : null;
    const prec = parseFloat(r.precip);
    const vis  = parseFloat(r.visibility);
    const reasons: string[] = [];
    if (wind > t.max_wind_mph)   reasons.push(`Wind ${wind.toFixed(1)} mph > ${t.max_wind_mph} mph limit`);
    // FIX-GUST: gust NULL (not modeled at this band) is never treated as a
    // violation — absence of gust data isn't evidence of calm conditions.
    if (gust !== null && gust > t.max_gust_mph) reasons.push(`Gust ${gust.toFixed(1)} mph > ${t.max_gust_mph} mph limit`);
    if (prec > t.max_precip)     reasons.push(`Precip ${prec.toFixed(2)} mm/hr > ${t.max_precip} mm/hr limit`);
    if (vis  < t.min_visibility) reasons.push(`Visibility ${vis}m < ${t.min_visibility}m minimum`);
    if (reasons.length) {
      violated.push({ id: r.id, lat: parseFloat(r.lat), lon: parseFloat(r.lon), wind_mph: wind, gust_mph: gust, precip: prec, visibility: vis, reasons });
      violatedIds.push(r.id);
    }
  }

  const { rows: geoRows } = await pool.query<{ safe_airspace: string | null; no_fly_union: string | null }>(`
    WITH bbox_geom AS (SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS geom),
    weather_bad AS (
      SELECT CASE WHEN cardinality($5::int[]) = 0 THEN NULL
        ELSE ST_Buffer(ST_Collect(geom)::geography, 5000)::geometry
      END AS geom
      FROM weather_grid
      WHERE id = ANY($5::int[])
        AND altitude_band = $6
    ),
    nfz AS (
      SELECT ST_Union(geom) AS geom FROM nfz_zones
      WHERE ST_Intersects(geom, (SELECT geom FROM bbox_geom))
        AND altitude_ceiling >= $7
        AND altitude_floor <= $8
        AND (end_time IS NULL OR end_time > NOW())
    ),
    combined_nofly AS (
      SELECT ST_Union(ARRAY_REMOVE(ARRAY[
        (SELECT geom FROM weather_bad),
        (SELECT geom FROM nfz)
      ], NULL)) AS geom
    ),
    safe AS (
      SELECT CASE
        WHEN (SELECT geom FROM combined_nofly) IS NULL THEN (SELECT geom FROM bbox_geom)
        ELSE ST_Difference((SELECT geom FROM bbox_geom), (SELECT geom FROM combined_nofly))
      END AS geom
    )
    SELECT
      ST_AsGeoJSON(safe.geom)          AS safe_airspace,
      ST_AsGeoJSON(combined_nofly.geom) AS no_fly_union
    FROM safe, combined_nofly
  `, [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat, violatedIds, band, altitudeCeiling, altitudeFloor]);

  const geo = geoRows[0];
  return {
    safe_airspace:   geo?.safe_airspace  ? JSON.parse(geo.safe_airspace)  : null,
    no_fly_zones:    geo?.no_fly_union   ? [{ type: "Feature", geometry: JSON.parse(geo.no_fly_union), properties: { source: "combined", reason: "Weather violations + active NFZ zones" } }] : [],
    violated_points: violated,
    altitude_band:   band,
    nfz_stale:       nfzStale,
    nfz_last_synced: nfzLastSynced,
  };
}
