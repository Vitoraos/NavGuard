// backend/scripts/syncWeatherGrid.ts
// Fills weather_grid with Open-Meteo forecast data.
// Stores 12 consecutive forecast hours per grid cell — not just current conditions.
// This enables flightStart → flightEnd weather window queries in ruleService.
// Run every 30 minutes via GitHub Actions cron.

import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Grid config ──────────────────────────────────────────────────────────────

const BBOX       = { minLat: 31.5, maxLat: 34.0, minLon: -98.5, maxLon: -95.5 };
const STEP       = 0.1;   // degrees — ~10km at DFW latitude
const BATCH_SIZE = 50;    // Open-Meteo batch limit per request
const HOURS      = 12;    // forecast hours to store per cell

// ─── Stable cell ID ───────────────────────────────────────────────────────────
// Converts lat/lon → stable integer per grid cell.
// Same formula used in the SQL migration unique constraint.

function cellId(lat: number, lon: number): number {
  return Math.round(lat / STEP) * 10000 + Math.round(lon / STEP);
}

// ─── Grid generator ───────────────────────────────────────────────────────────

interface GridPoint { lat: number; lon: number; cell_id: number; }

function generateGrid(): GridPoint[] {
  const points: GridPoint[] = [];
  for (let lat = BBOX.minLat; lat <= BBOX.maxLat; lat = +(lat + STEP).toFixed(4)) {
    for (let lon = BBOX.minLon; lon <= BBOX.maxLon; lon = +(lon + STEP).toFixed(4)) {
      points.push({ lat, lon, cell_id: cellId(lat, lon) });
    }
  }
  return points;
}

// ─── Open-Meteo batch fetch ───────────────────────────────────────────────────
// Passes multiple lat/lon values in one HTTP call.
// Returns next HOURS forecast readings per point.

interface WeatherReading {
  cell_id:    number;
  lat:        number;
  lon:        number;
  wind_mph:   number;
  precip:     number;
  visibility: number;
  fetched_at: string;
}

async function fetchBatch(points: GridPoint[]): Promise<WeatherReading[]> {
  const lats = points.map(p => p.lat).join(",");
  const lons = points.map(p => p.lon).join(",");

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lats}` +
    `&longitude=${lons}` +
    `&hourly=windspeed_10m,precipitation,visibility` +
    `&wind_speed_unit=mph` +
    `&forecast_days=1` +
    `&timezone=UTC`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);

  const data      = await res.json();
  const forecasts: any[] = Array.isArray(data) ? data : [data];

  // Find current UTC hour index in the time array
  const nowHourISO = new Date().toISOString().slice(0, 13);
  const readings: WeatherReading[] = [];

  forecasts.forEach((forecast: any, idx: number) => {
    const times: string[] = forecast.hourly.time;
    const startIdx = times.findIndex(t => t.startsWith(nowHourISO));
    const from     = startIdx >= 0 ? startIdx : 0;

    // Store HOURS consecutive forecast readings per cell
    for (let h = 0; h < HOURS; h++) {
      const i = from + h;
      if (i >= times.length) break;

      readings.push({
        cell_id:    points[idx].cell_id,
        lat:        points[idx].lat,
        lon:        points[idx].lon,
        wind_mph:   forecast.hourly.windspeed_10m[i]  ?? 0,
        precip:     forecast.hourly.precipitation[i]  ?? 0,
        visibility: forecast.hourly.visibility[i]     ?? 9999,
        fetched_at: times[i],
      });
    }
  });

  return readings;
}

// ─── Batch upsert ─────────────────────────────────────────────────────────────
// Uses UNIQUE (cell_id, fetched_at) constraint — no duplicate rows per cell per hour.
// Does NOT insert `restricted` — it is GENERATED ALWAYS by Postgres.

async function upsertBatch(readings: WeatherReading[]): Promise<void> {
  if (!readings.length) return;

  await pool.query(`
    INSERT INTO public.weather_grid
      (cell_id, geom, wind_mph, precip, visibility, fetched_at)
    SELECT
      cell_id,
      ST_SetSRID(ST_MakePoint(lon, lat), 4326),
      wind, precip, vis, fetched::timestamptz
    FROM UNNEST(
  $1::bigint[],
  $2::float[],
  $3::float[],
  $4::float[],
  $5::float[],
  $6::float[],
  $7::text[]
) AS t(cell_id, lat, lon, wind, precip, vis, fetched)
    ON CONFLICT (cell_id, fetched_at)
    DO UPDATE SET
      wind_mph   = EXCLUDED.wind_mph,
      precip     = EXCLUDED.precip,
      visibility = EXCLUDED.visibility,
      geom       = EXCLUDED.geom
  `, [
    readings.map(r => r.cell_id),
    readings.map(r => r.lat),
    readings.map(r => r.lon),
    readings.map(r => r.wind_mph),
    readings.map(r => r.precip),
    readings.map(r => r.visibility),
    readings.map(r => r.fetched_at),
  ]);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function deleteStale(): Promise<number> {
  const { rowCount } = await pool.query(`
    DELETE FROM public.weather_grid
    WHERE fetched_at < NOW() - INTERVAL '1 hour'
  `);
  return rowCount ?? 0;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Starting weather grid sync (${HOURS}h forecast)...`);
  const grid = generateGrid();
  console.log(`Grid: ${grid.length} points × ${HOURS} hours = ${grid.length * HOURS} readings`);

  let totalOk = 0, totalFailed = 0;

  for (let i = 0; i < grid.length; i += BATCH_SIZE) {
    const batch = grid.slice(i, i + BATCH_SIZE);
    try {
      const readings = await fetchBatch(batch);
      await upsertBatch(readings);
      totalOk += readings.length;
    } catch (err) {
      console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err);
      totalFailed += batch.length;
    }
    if (i + BATCH_SIZE < grid.length) await new Promise(r => setTimeout(r, 150));
  }

  const deleted = await deleteStale();
  console.log(`Done — ok: ${totalOk}, failed: ${totalFailed}, deleted stale: ${deleted}`);
  await pool.end();
}

main().catch(err => {
  console.error("syncWeatherGrid crashed:", err);
  process.exit(1);
});
