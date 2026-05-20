// scripts/syncWeatherGrid.ts
// Fills weather_grid with a lat/lon grid of points from Open-Meteo.
// Runs every 30 min via GitHub Actions cron.

import { Pool } from "pg";
import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BBOX = { minLat: 31.5, maxLat: 34.0, minLon: -98.5, maxLon: -95.5 };
const STEP = 0.25;
const BATCH_SIZE = 5;

interface GridPoint { lat: number; lon: number; }
interface WeatherReading { wind_mph: number; precip: number; visibility: number; }

function generateGrid(): GridPoint[] {
  const points: GridPoint[] = [];
  for (let lat = BBOX.minLat; lat <= BBOX.maxLat; lat = +(lat + STEP).toFixed(4)) {
    for (let lon = BBOX.minLon; lon <= BBOX.maxLon; lon = +(lon + STEP).toFixed(4)) {
      points.push({ lat, lon });
    }
  }
  return points;
}

async function fetchWeather(lat: number, lon: number): Promise<WeatherReading> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=windspeed_10m,precipitation,visibility` +
    `&wind_speed_unit=mph` +
    `&forecast_hours=2` +
    `&timezone=UTC`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status} for (${lat},${lon})`);
  const data = await res.json();
  const nowISO  = new Date().toISOString().slice(0, 13);
  const idx     = (data.hourly.time as string[]).findIndex(t => t.startsWith(nowISO));
  const i       = idx >= 0 ? idx : 0;
  return {
    wind_mph:   data.hourly.windspeed_10m[i] ?? 0,
    precip:     data.hourly.precipitation[i] ?? 0,
    visibility: data.hourly.visibility[i]    ?? 9999,
  };
}

async function upsertPoint(lat: number, lon: number, w: WeatherReading): Promise<void> {
  await pool.query(`
    INSERT INTO weather_grid (geom, wind_mph, precip, visibility, fetched_at)
    VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, $4, $5, NOW())
    ON CONFLICT ON CONSTRAINT weather_grid_geom_unique
    DO UPDATE SET
      wind_mph   = EXCLUDED.wind_mph,
      precip     = EXCLUDED.precip,
      visibility = EXCLUDED.visibility,
      fetched_at = NOW()
  `, [lon, lat, w.wind_mph, w.precip, w.visibility]);
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting weather grid sync...`);
  const grid = generateGrid();
  console.log(`Grid: ${grid.length} points over DFW bbox`);
  let ok = 0, failed = 0;
  for (let i = 0; i < grid.length; i += BATCH_SIZE) {
    const batch = grid.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async ({ lat, lon }) => {
      try {
        const w = await fetchWeather(lat, lon);
        await upsertPoint(lat, lon, w);
        ok++;
      } catch (err) {
        console.error(`  FAIL (${lat},${lon}):`, err);
        failed++;
      }
    }));
    if (i + BATCH_SIZE < grid.length) await new Promise(r => setTimeout(r, 200));
  }
  console.log(`Done — ok: ${ok}, failed: ${failed}`);
  await pool.end();
}

main().catch(err => { console.error("syncWeatherGrid crashed:", err); process.exit(1); });