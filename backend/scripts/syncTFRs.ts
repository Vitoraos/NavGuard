// scripts/syncTFRs.ts
// Fetches active TFRs from AeroAPI and upserts them into nfz_zones.
// Run every 10 minutes via GitHub Actions cron.
// Never wipes existing data on failure — safe to run repeatedly.

import { Pool } from "pg";
import dotenv from "dotenv";
import { normalizeAeroAPITFR, NFZZone } from "./normalizeToNFZZone.js";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const AEROAPI_BASE = "https://aeroapi.flightaware.com/aeroapi";
const AEROAPI_KEY  = process.env.AEROAPI_KEY!;

const DFW_BBOX = {
  minLat: 31.5, maxLat: 34.0,
  minLon: -98.5, maxLon: -95.5,
};

async function fetchTFRs(): Promise<any[]> {
  const url =
    `${AEROAPI_BASE}/tfrs?` +
    `min_latitude=${DFW_BBOX.minLat}&max_latitude=${DFW_BBOX.maxLat}` +
    `&min_longitude=${DFW_BBOX.minLon}&max_longitude=${DFW_BBOX.maxLon}`;

  const res = await fetch(url, {
    headers: { "x-apikey": AEROAPI_KEY, "Accept": "application/json; charset=UTF-8" },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AeroAPI error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.tfrs ?? [];
}

async function upsertZone(zone: NFZZone): Promise<void> {
  await pool.query(`
    INSERT INTO public.nfz_zones
      (external_id, name, reason, source, type,
       altitude_floor, altitude_ceiling, start_time, end_time, last_synced, geom)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),ST_SetSRID(ST_GeomFromGeoJSON($10),4326))
    ON CONFLICT (external_id) DO UPDATE SET
      name             = EXCLUDED.name,
      reason           = EXCLUDED.reason,
      type             = EXCLUDED.type,
      altitude_floor   = EXCLUDED.altitude_floor,
      altitude_ceiling = EXCLUDED.altitude_ceiling,
      start_time       = EXCLUDED.start_time,
      end_time         = EXCLUDED.end_time,
      last_synced      = NOW(),
      geom             = EXCLUDED.geom
  `, [
    zone.external_id, zone.name, zone.reason, zone.source, zone.type,
    zone.altitude_floor, zone.altitude_ceiling,
    zone.start_time?.toISOString() ?? null,
    zone.end_time?.toISOString()   ?? null,
    JSON.stringify(zone.geom),
  ]);
}

async function deleteExpired(): Promise<number> {
  const result = await pool.query(`
    DELETE FROM public.nfz_zones
    WHERE end_time IS NOT NULL AND end_time < NOW() AND type = 'TFR'
  `);
  return result.rowCount ?? 0;
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting TFR sync...`);

  let rawTFRs: any[];
  try {
    rawTFRs = await fetchTFRs();
    console.log(`Fetched ${rawTFRs.length} TFRs from AeroAPI`);
  } catch (err) {
    console.error("Failed to fetch from AeroAPI:", err);
    process.exit(1);
  }

  let inserted = 0, skipped = 0;
  for (const raw of rawTFRs) {
    const zone = normalizeAeroAPITFR(raw);
    if (!zone) { skipped++; continue; }
    try {
      await upsertZone(zone);
      inserted++;
    } catch (err) {
      console.error(`Failed to upsert zone ${raw.tfr_id}:`, err);
      skipped++;
    }
  }

  const deleted = await deleteExpired();
  console.log(`Sync complete — inserted/updated: ${inserted}, skipped: ${skipped}, deleted expired: ${deleted}`);
  await pool.end();
}

main().catch((err) => { console.error("Sync crashed:", err); process.exit(1); });