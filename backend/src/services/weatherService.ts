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

  // FIX-09: 35 minutes matches zoneEngine fetched_at filter
  const STALE_THRESHOLD = Number(process.env.WEATHER_STALE_MINUTES ?? 35);
  return { last_synced, stale: stale_minutes > STALE_THRESHOLD, stale_minutes };
}
