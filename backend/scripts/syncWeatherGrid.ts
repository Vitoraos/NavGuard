// scripts/syncWeatherGrid.ts
// Syncs Open-Meteo 12-hour hourly forecast into weather_grid.
//
// Key columns:
//   fetched_at    = timestamp when THIS sync run executed (staleness guard)
//   forecast_time = the actual hour this row represents (e.g. 14:00, 15:00)
//   altitude_band = 'surface' | '925hPa' | '850hPa'
//   gust_mph      = wind gust speed, surface only (Open-Meteo doesn't model
//                   gusts at pressure levels) — NULL for 925hPa/850hPa rows,
//                   meaning "not modeled," not "no gust."
//
// queryWeatherTimeline joins on forecast_time closest to the drone's ETA,
// so a flight planned 3 hours from now gets the correct forecast conditions.
//
// FIX-PRESSURE-BAND: previously this script only ever wrote 'surface' rows
// (altitude_band was missing from the INSERT column list entirely, so every
// row silently took the column default). Any query for '925hPa' or '850hPa'
// — which the app *does* make for flights with a higher ceiling — returned
// zero rows. Now fetches pressure-level wind and writes one row per band.
//
// FIX-GUST: previously only wind_speed_10m (sustained wind) was fetched.
// Gusts are a materially different, often more dangerous, failure mode for
// small airframes. wind_gusts_10m is now pulled alongside sustained wind.
//
// FIX-API-NAMING: this file previously used the pre-1.0.0 Open-Meteo names
// (windspeed_10m, windgusts_10m, windspeed_925hPa/850hPa). Open-Meteo
// renamed these for consistency at their 1.0.0 release. Using the old names
// risks the API silently omitting them from the response rather than
// erroring, which would make every point fail schema validation with no
// visible error — the sync job would appear to succeed while writing
// nothing. Now uses the currently-documented names throughout.

import pkg from "pg";
const { Pool } = pkg;
import dotenv from "dotenv";
dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const BBOX       = { minLat: 32.0, maxLat: 33.5, minLon: -97.5, maxLon: -96.0 };
const STEP       = 0.25;
const HOURS      = 12;
const BATCH_SIZE = 10;

// FIX-PRESSURE-BAND: altitude bands and the pressure level each maps to.
// Keep in sync with selectBand() in flightService.ts / ruleService.ts.
const ALTITUDE_BANDS = [
  { band: "surface", pressureLevel: null as string | null },
  { band: "925hPa",  pressureLevel: "925hPa" },
  { band: "850hPa",  pressureLevel: "850hPa" },
];

function cellId(lat: number, lon: number): number {
  return Math.round((lat + 90) * 1000) * 1000000 + Math.round((lon + 180) * 1000);
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
  cell_id:       number;
  lat:           number;
  lon:           number;
  elevation_m:   number;
  altitude_band: string;
  wind_mph:      number;
  gust_mph:      number | null; // null = not modeled at this level (925hPa/850hPa)
  precip:        number;
  visibility:    number;
  forecast_time: string; // ISO string — the hour this row represents
  fetched_at:    string; // ISO string — when this sync ran
}

// FIX-API-NAMING: Open-Meteo renamed these at their 1.0.0 release for
// consistency ("windspeed_10m" -> "wind_speed_10m", etc). Using the old
// names means the API silently omits these keys from the response instead
// of erroring, which made isValidForecast() reject every point's forecast
// with no visible failure — the sync would appear to succeed while writing
// zero usable rows.
interface OpenMeteoHourly {
  time:                string[];
  wind_speed_10m:      number[];
  wind_gusts_10m:      number[];
  precipitation:       number[];
  visibility:          number[];
  wind_speed_925hPa?:  number[];
  wind_speed_850hPa?:  number[];
}

interface OpenMeteoResponse {
  latitude:  number;
  longitude: number;
  elevation: number;
  hourly:    OpenMeteoHourly;
}

function isValidForecast(data: any): data is OpenMeteoResponse {
  if (!data || !data.hourly) return false;
  const h = data.hourly;
  // Surface fields are required. Pressure-level fields are validated
  // separately per-band below since Open-Meteo can drop them independently
  // (e.g. rate limiting a subset of variables) without failing the whole
  // response — we don't want a pressure-level hiccup to also throw out
  // valid surface data.
  if (!Array.isArray(h.time) || !Array.isArray(h.wind_speed_10m) ||
      !Array.isArray(h.wind_gusts_10m) ||
      !Array.isArray(h.precipitation) || !Array.isArray(h.visibility)) return false;
  if (h.time.length === 0 ||
      h.time.length !== h.wind_speed_10m.length ||
      h.time.length !== h.wind_gusts_10m.length ||
      h.time.length !== h.precipitation.length ||
      h.time.length !== h.visibility.length) return false;
  return true;
}

async function fetchRawWeather(points: GridPoint[], maxRetries = 3): Promise<any[]> {
  const lats = points.map(p => p.lat).join(",");
  const lons  = points.map(p => p.lon).join(",");
  const hourlyParams = [
    "wind_speed_10m",
    "wind_gusts_10m",
    "precipitation",
    "visibility",
    "wind_speed_925hPa",
    "wind_speed_850hPa",
  ].join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=${hourlyParams}&wind_speed_unit=mph&forecast_days=1&timezone=UTC`;

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

// FIX-PRESSURE-BAND: emits one reading PER BAND per hour (surface + 925hPa +
// 850hPa), instead of one reading per hour total. Precip/visibility are
// surface-only in Open-Meteo's model — there's no per-level equivalent — so
// every band reuses the surface precip/visibility reading. That's a known
// simplification: it means precip/visibility restrictions are still
// effectively surface-based even in the 3D volume, only wind (and gust, at
// surface) are genuinely altitude-differentiated. Worth revisiting if
// precip/visibility at altitude turns out to matter for your ops profile.
function transformToReadings(points: GridPoint[], forecasts: any[]): WeatherReading[] {
  const nowHourISO = new Date().toISOString().slice(0, 13); // "2026-06-03T14"
  const fetchedAt  = new Date().toISOString();              // sync run timestamp
  const readings: WeatherReading[] = [];

  // FIX-POINT-MATCH: Open-Meteo returns multi-location results in the same
  // order as the requested latitude/longitude lists, so pair by index
  // rather than by coordinate proximity. The API's returned lat/lon is the
  // center of whatever grid cell the model actually uses, which the docs
  // note "might be a few kilometres away" from the requested point — for
  // coarser global models that offset can exceed a fixed degree-based
  // tolerance and silently drop the point. Index pairing sidesteps that;
  // the proximity check below is now just a sanity guard against a
  // response-order mismatch, not the primary matching method.
  forecasts.forEach((rawForecast, idx) => {
    if (!isValidForecast(rawForecast)) {
      console.warn(`[Data] Skipped invalid forecast schema at index ${idx}.`);
      return;
    }

    const point = points[idx];
    if (!point) {
      console.warn(`[Data] No matching grid point for forecast at index ${idx}.`);
      return;
    }
    // Sanity check, not a filter: if this ever fires, request/response
    // ordering assumptions have broken and the mapping needs re-checking.
    if (Math.abs(point.lat - rawForecast.latitude) > 1 || Math.abs(point.lon - rawForecast.longitude) > 1) {
      console.warn(`[Data] Forecast at index ${idx} is >1° from expected point ${point.cell_id} — possible response ordering mismatch.`);
    }

    const times      = rawForecast.hourly.time;
    const startIdx    = times.findIndex((t: string) => t.startsWith(nowHourISO));
    const from        = startIdx >= 0 ? startIdx : 0;
    const elevationM  = rawForecast.elevation ?? 0;

    for (const { band, pressureLevel } of ALTITUDE_BANDS) {
      const pressureKey = pressureLevel ? (`wind_speed_${pressureLevel}` as const) : null;
      const pressureSeries: number[] | undefined = pressureKey ? (rawForecast.hourly as any)[pressureKey] : undefined;

      if (pressureLevel && (!Array.isArray(pressureSeries) || pressureSeries.length !== times.length)) {
        // Pressure-level data missing/malformed for this point this run —
        // skip just this band, not the whole point. surface band is
        // independent and still gets written below.
        console.warn(`[Data] Missing ${pressureKey} for cell ${point.cell_id}, skipping ${band} band this run.`);
        continue;
      }

      for (let h = 0; h < HOURS; h++) {
        const i = from + h;
        if (i >= times.length) break;

        const windMph = band === "surface"
          ? (rawForecast.hourly.wind_speed_10m[i] ?? 0)
          : (pressureSeries![i] ?? 0);

        readings.push({
          cell_id:       point.cell_id,
          lat:           point.lat,
          lon:           point.lon,
          elevation_m:   elevationM,
          altitude_band: band,
          wind_mph:      windMph,
          gust_mph:      band === "surface" ? (rawForecast.hourly.wind_gusts_10m[i] ?? 0) : null,
          precip:        rawForecast.hourly.precipitation[i] ?? 0,
          visibility:    rawForecast.hourly.visibility[i]    ?? 9999,
          forecast_time: new Date(times[i] + ":00:00Z").toISOString(), // the hour this row IS
          fetched_at:    fetchedAt,                                     // when we synced
        });
      }
    }
  });

  return readings;
}

async function upsertBatch(readings: WeatherReading[]): Promise<void> {
  if (!readings.length) return;

  // FIX-PRESSURE-BAND: altitude_band and gust_mph are now actually in the
  // column list and UNNEST array — this was the root cause of 925hPa/850hPa
  // queries always returning zero rows.
  await pool.query(`
    INSERT INTO public.weather_grid
      (cell_id, geom, elevation_m, altitude_band, wind_mph, gust_mph, precip, visibility, forecast_time, fetched_at)
    SELECT
      cell_id,
      ST_SetSRID(ST_MakePoint(lon, lat), 4326),
      elev, band, wind, gust, precip, vis,
      ft::timestamptz,
      fa::timestamptz
    FROM UNNEST(
      $1::bigint[], $2::float[], $3::float[], $4::float[], $5::text[],
      $6::float[], $7::float[], $8::float[], $9::float[],
      $10::text[], $11::text[]
    ) AS t(cell_id, lat, lon, elev, band, wind, gust, precip, vis, ft, fa)
    ON CONFLICT (cell_id, altitude_band, forecast_time)
    DO UPDATE SET
      wind_mph      = EXCLUDED.wind_mph,
      gust_mph      = EXCLUDED.gust_mph,
      precip        = EXCLUDED.precip,
      visibility    = EXCLUDED.visibility,
      elevation_m   = EXCLUDED.elevation_m,
      geom          = EXCLUDED.geom,
      fetched_at    = EXCLUDED.fetched_at
  `, [
    readings.map(r => r.cell_id),
    readings.map(r => r.lat),
    readings.map(r => r.lon),
    readings.map(r => r.elevation_m),
    readings.map(r => r.altitude_band),
    readings.map(r => r.wind_mph),
    readings.map(r => r.gust_mph),
    readings.map(r => r.precip),
    readings.map(r => r.visibility),
    readings.map(r => r.forecast_time),
    readings.map(r => r.fetched_at),
  ]);
}

async function deleteStale(): Promise<number> {
  // Delete rows whose forecast_time is in the past — no longer useful
  // Keep rows fetched within last 50 minutes in case of brief API outage
  const { rowCount } = await pool.query(`
    DELETE FROM public.weather_grid
    WHERE forecast_time < NOW() - INTERVAL '1 hour'
      AND fetched_at < NOW() - INTERVAL '50 minutes'
  `);
  return rowCount ?? 0;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting weather grid sync (${HOURS}h forecast, ${ALTITUDE_BANDS.length} bands)...`);
  const grid = generateGrid();
  console.log(`Grid: ${grid.length} points × ${HOURS} hours × ${ALTITUDE_BANDS.length} bands = up to ${grid.length * HOURS * ALTITUDE_BANDS.length} readings`);

  let totalOk = 0, totalFailed = 0;

  for (let i = 0; i < grid.length; i += BATCH_SIZE) {
    const batch = grid.slice(i, i + BATCH_SIZE);
    try {
      const rawForecasts = await fetchRawWeather(batch);
      const readings     = transformToReadings(batch, rawForecasts);
      await upsertBatch(readings);
      totalOk += readings.length;
    } catch (err) {
      console.error(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed after retries:`, err);
      totalFailed += batch.length * HOURS * ALTITUDE_BANDS.length;
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
