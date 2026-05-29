// backend/src/services/weatherService.ts
// DB-only — no live HTTP calls at request time.
// Grid is filled by syncWeatherGrid.ts every 30 minutes.

import { pool } from "../config/db";

export async function getWeatherFreshness(): Promise<{
  last_synced:   Date | null;
  stale:         boolean;
  stale_minutes: number;
}> {
  const { rows } = await pool.query(
    "SELECT MAX(fetched_at) AS synced FROM weather_grid"
  );
  const last_synced   = rows[0]?.synced ?? null;
  const ageMs         = last_synced
    ? Date.now() - new Date(last_synced).getTime()
    : Infinity;
  const stale_minutes = Math.floor(ageMs / 60_000);
  return { last_synced, stale: stale_minutes > 60, stale_minutes };
}
