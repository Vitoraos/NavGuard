// backend/scripts/syncWeatherGrid.ts
// Fills weather_grid with Open-Meteo forecast data.
// Stores 12 consecutive forecast hours per grid cell — not just current conditions.
// This enables flightStart → flightEnd weather window queries in ruleService.
// Run every 30 minutes via GitHub Actions cron.

import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

// FIX-03: implicit_fetch_dependency - Enforce Node 18+ requirement explicitly
if (typeof fetch === "undefined") {
  throw new Error("Node 18+ is required to support the native fetch API.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Grid config ──────────────────────────────────────────────────────────────
const BBOX       = { minLat: 31.5, maxLat: 34.0, minLon: -98.5, maxLon: -95.5 };
const STEP       = 0.05;   // degrees — ~10km at DFW latitude
const BATCH_SIZE = 50;    // Open-Meteo batch limit per request
const HOURS      = 12;    // forecast hours to store per cell

// ─── Stable cell ID ───────────────────────────────────────────────────────────
// FIX-05: cell_id_collision_risk
// Added +90 and +180 offsets to ensure coordinates are exclusively positive before mapping.
// *NOTE*: Ensure your SQL migration 'GENERATED ALWAYS' column logic matches this update!
function cellId(lat: number, lon: number): number {
  return Math.round((lat + 90) / STEP) * 10000 + Math.round((lon + 180) / STEP);
}

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

// ─── Types & Validation (FIX-02, FIX-04) ──────────────────────────────────────
interface WeatherReading {
  cell_id:    number;
  lat:        number;
  lon:        number;
  wind_mph:   number;
  precip:     number;
  visibility: number;
  fetched_at: string; // Note: This stores the target forecast hour, not the execution time
}

interface OpenMeteoHourly {
  time: string[];
  windspeed_10m: number[];
  precipitation: number[];
  visibility: number[];
}

interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  hourly: OpenMeteoHourly;
}

// Runtime schema validator to prevent NaN propagation if API changes
function isValidForecast(data: any): data is OpenMeteoResponse {
  if (!data || !data.hourly) return false;
  const h = data.hourly;
  if (!Array.isArray(h.time) || !Array.isArray(h.windspeed_10m) ||
      !Array.isArray(h.precipitation) || !Array.isArray(h.visibility)) {
    return false;
  }
  // Ensure array data lengths match up perfectly
  if (h.time.length === 0 || 
      h.time.length !== h.windspeed_10m.length ||
      h.time.length !== h.precipitation.length ||
      h.time.length !== h.visibility.length) {
    return false;
  }
  return true;
}

// ─── API Fetching & Transformation (FIX-06, FIX-07, FIX-08) ───────────────────
async function fetchRawWeather(points: GridPoint[], maxRetries = 3): Promise<any[]> {
  const lats = points.map(p => p.lat).join(",");
  const lons = points.map(p => p.lon).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=windspeed_10m,precipitation,visibility&wind_speed_unit=mph&forecast_days=1&timezone=UTC`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      
      // FIX-08: Check for 429 Too Many Requests and use Retry-After header
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : 2000 * attempt;
        console.warn(`[API] Rate limited. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      return Array.isArray(data) ? data : [data];

    } catch (err: any) {
      // FIX-06: Implement exponential backoff for failed batches
      if (attempt === maxRetries) throw err;
      const backoffMs = 1000 * Math.pow(2, attempt);
      console.warn(`[API] Fetch failed, retrying in ${backoffMs}ms... (Attempt ${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return [];
}

// FIX-01: Map API response using explicit identifiers rather than blind array index
function transformToReadings(points: GridPoint[], forecasts: any[]): WeatherReading[] {
  const nowHourISO = new Date().toISOString().slice(0, 13);
  const readings: WeatherReading[] = [];

  forecasts.forEach((rawForecast) => {
    // FIX-04: Validate response schema
    if (!isValidForecast(rawForecast)) {
      console.warn(`[Data] Skipped invalid forecast schema.`);
      return;
    }

    // Safely map Open-Meteo's returned coordinates back to our exact grid point
    // Using a 0.05 tolerance to account for minor floating point rounding from the API
    const point = points.find(p => 
      Math.abs(p.lat - rawForecast.latitude) < 0.05 && 
      Math.abs(p.lon - rawForecast.longitude) < 0.05
    );

    if (!point) {
      console.warn(`[Data] Could not align forecast coordinates (${rawForecast.latitude}, ${rawForecast.longitude}) to requested grid point.`);
      return;
    }

    const times = rawForecast.hourly.time;
    const startIdx = times.findIndex(t => t.startsWith(nowHourISO));
    const from = startIdx >= 0 ? startIdx : 0;

    for (let h = 0; h < HOURS; h++) {
      const i = from + h;
      if (i >= times.length) break;

      readings.push({
        cell_id:    point.cell_id,
        lat:        point.lat,
        lon:        point.lon,
        wind_mph:   rawForecast.hourly.windspeed_10m[i] ?? 0,
        precip:     rawForecast.hourly.precipitation[i] ?? 0,
        visibility: rawForecast.hourly.visibility[i]    ?? 9999,
        fetched_at: times[i], // Represents the forecast target hour
      });
    }
  });

  return readings;
}

// ─── Batch upsert ─────────────────────────────────────────────────────────────
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
      $1::bigint[], $2::float[], $3::float[], $4::float[], $5::float[], $6::float[], $7::text[] 
    ) AS t(cell_id, lat, lon, wind, precip, vis, fetched) 
    ON CONFLICT (cell_id, fetched_at) 
    DO UPDATE SET 
      wind_mph = EXCLUDED.wind_mph, 
      precip = EXCLUDED.precip, 
      visibility = EXCLUDED.visibility, 
      geom = EXCLUDED.geom
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
// FIX-09: Clarification - `fetched_at` stores the TARGET FORECAST HOUR (e.g. 2:00 PM).
// Deleting records where `fetched_at` < NOW() - 50 mins effectively deletes 
// past forecast data that is no longer relevant, safely preserving future horizons.
async function deleteStale(): Promise<number> {
  const { rowCount } = await pool.query(`
    DELETE FROM public.weather_grid 
    WHERE fetched_at < NOW() - INTERVAL '50 minutes'
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
      const rawForecasts = await fetchRawWeather(batch);
      const readings = transformToReadings(batch, rawForecasts);
      
      await upsertBatch(readings);
      totalOk += readings.length;
      
    } catch (err) {
      console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} completely failed after retries:`, err);
      totalFailed += batch.length * HOURS; 
    }
    
    // Slight pause between successful batches (will be skipped if 429 handled via Retry-After)
    if (i + BATCH_SIZE < grid.length) await new Promise(r => setTimeout(r, 150));
  }
  
  const deleted = await deleteStale();
  console.log(`Done — ok: ${totalOk}, failed: ${totalFailed}, deleted past forecasts: ${deleted}`);
  await pool.end();
}

main().catch(err => {
  console.error("syncWeatherGrid crashed:", err);
  process.exit(1);
});
