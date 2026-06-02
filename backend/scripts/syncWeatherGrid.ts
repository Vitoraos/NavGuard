// backend/scripts/syncWeatherGrid.ts
import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

if (typeof fetch === "undefined") {
  throw new Error("Node 18+ is required to support the native fetch API.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BBOX = { minLat: 31.5, maxLat: 34.0, minLon: -98.5, maxLon: -95.5 };
const STEP = 0.05;
const BATCH_SIZE = 50;
const HOURS = 12;

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

interface WeatherReading {
  cell_id: number;
  lat: number;
  lon: number;
  elevation_m: number; // FIX: Added for AGL -> MSL conversion
  wind_mph: number;
  precip: number;
  visibility: number;
  fetched_at: string;
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
  elevation: number; // FIX: Added to capture terrain elevation
  hourly: OpenMeteoHourly;
}

function isValidForecast(data: any): data is OpenMeteoResponse {
  if (!data || !data.hourly) return false;
  const h = data.hourly;
  if (!Array.isArray(h.time) || !Array.isArray(h.windspeed_10m) ||
      !Array.isArray(h.precipitation) || !Array.isArray(h.visibility)) {
    return false;
  }
  if (h.time.length === 0 || h.time.length !== h.windspeed_10m.length ||
      h.time.length !== h.precipitation.length || h.time.length !== h.visibility.length) {
    return false;
  }
  return true;
}

async function fetchRawWeather(points: GridPoint[], maxRetries = 3): Promise<any[]> {
  const lats = points.map(p => p.lat).join(",");
  const lons = points.map(p => p.lon).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=windspeed_10m,precipitation,visibility&wind_speed_unit=mph&forecast_days=1&timezone=UTC`;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : 2000 * attempt;
        console.warn(`[API] Rate limited. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
      
      const data = await res.json();
      return Array.isArray(data) ? data : [data];
    } catch (err: any) {
      if (attempt === maxRetries) throw err;
      const backoffMs = 1000 * Math.pow(2, attempt);
      console.warn(`[API] Fetch failed, retrying in ${backoffMs}ms... (Attempt ${attempt}/${maxRetries})`);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  return [];
}

function transformToReadings(points: GridPoint[], forecasts: any[]): WeatherReading[] {
  const nowHourISO = new Date().toISOString().slice(0, 13);
  const readings: WeatherReading[] = [];

  forecasts.forEach((rawForecast) => {
    if (!isValidForecast(rawForecast)) {
      console.warn(`[Data] Skipped invalid forecast schema.`);
      return;
    }

    const point = points.find(p => 
      Math.abs(p.lat - rawForecast.latitude) < 0.05 && 
      Math.abs(p.lon - rawForecast.longitude) < 0.05
    );

    if (!point) {
      console.warn(`[Data] Could not align forecast coordinates.`);
      return;
    }

    const times = rawForecast.hourly.time;
    const startIdx = times.findIndex(t => t.startsWith(nowHourISO));
    const from = startIdx >= 0 ? startIdx : 0;
    
    // FIX: Capture elevation from the root response (static per cell)
    const elevationM = rawForecast.elevation ?? 0; 

    for (let h = 0; h < HOURS; h++) {
      const i = from + h;
      if (i >= times.length) break;
      readings.push({
        cell_id: point.cell_id,
        lat: point.lat,
        lon: point.lon,
        elevation_m: elevationM, // FIX: Added
        wind_mph: rawForecast.hourly.windspeed_10m[i] ?? 0,
        precip: rawForecast.hourly.precipitation[i] ?? 0,
        visibility: rawForecast.hourly.visibility[i] ?? 9999,
        fetched_at: times[i],
      });
    }
  });
  return readings;
}

async function upsertBatch(readings: WeatherReading[]): Promise<void> {
  if (!readings.length) return;
  // FIX: Added elevation_m to INSERT, UNNEST, and ON CONFLICT
  await pool.query(`
    INSERT INTO public.weather_grid 
    (cell_id, geom, elevation_m, wind_mph, precip, visibility, fetched_at) 
    SELECT 
      cell_id, 
      ST_SetSRID(ST_MakePoint(lon, lat), 4326), 
      elev, wind, precip, vis, fetched::timestamptz 
    FROM UNNEST(
      $1::bigint[], $2::float[], $3::float[], $4::float[], $5::float[], $6::float[], $7::float[], $8::text[]
    ) AS t(cell_id, lat, lon, elev, wind, precip, vis, fetched)
    ON CONFLICT (cell_id, fetched_at) 
    DO UPDATE SET 
      wind_mph = EXCLUDED.wind_mph,
      precip = EXCLUDED.precip,
      visibility = EXCLUDED.visibility,
      elevation_m = EXCLUDED.elevation_m,
      geom = EXCLUDED.geom
  `, [
    readings.map(r => r.cell_id),
    readings.map(r => r.lat),
    readings.map(r => r.lon),
    readings.map(r => r.elevation_m), // FIX: Added
    readings.map(r => r.wind_mph),
    readings.map(r => r.precip),
    readings.map(r => r.visibility),
    readings.map(r => r.fetched_at),
  ]);
}

async function deleteStale(): Promise<number> {
  const { rowCount } = await pool.query(`
    DELETE FROM public.weather_grid WHERE fetched_at < NOW() - INTERVAL '50 minutes'
  `);
  return rowCount ?? 0;
}

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
