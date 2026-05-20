import { Request, Response } from "express";
import { queryAirspace } from "../services/ruleService.js";
import { getWeatherStatus } from "../services/weatherService.js";
import { isValidLatLon, isValidAltitude, isValidBuffer } from "../utils/validators.js";
import { parseFlightTime } from "../utils/time.js";
import { pool } from "../config/db.js";

export async function scanHandler(req: Request, res: Response) {
  try {
    const { origin, destination, buffer_km, altitude_floor, altitude_ceiling, start_time } = req.body;

    if (!isValidLatLon(origin) || !isValidLatLon(destination))
      return res.status(400).json({ error: "Invalid coordinates" });

    const floor = Number(altitude_floor ?? 0);
    const ceil  = Number(altitude_ceiling ?? 4000);
    if (!isValidAltitude(floor, ceil))
      return res.status(400).json({ error: "Invalid altitude range" });

    const bufferMeters = Math.min(Math.max(Number(buffer_km ?? 10), 1), 50) * 1000;
    if (!isValidBuffer(bufferMeters))
      return res.status(400).json({ error: "Invalid buffer size" });

    const flightStart = parseFlightTime(start_time);
    if (!flightStart)
      return res.status(400).json({ error: "Invalid ISO 8601 start_time" });

    // 1. Freshness check — never serve stale data silently
    const { rows: freshnessRows } = await pool.query(
      "SELECT MAX(last_synced) AS synced FROM nfz_zones"
    );
    const lastSynced = freshnessRows[0]?.synced;
    const stale = !lastSynced ||
      Date.now() - new Date(lastSynced).getTime() > 15 * 60 * 1000;

    if (stale) {
      return res.status(503).json({
        error:       "Airspace data is stale",
        last_synced: lastSynced ?? null,
        message:     "Data older than 15 minutes. Do not use for active flight planning.",
      });
    }

    // 2. Run airspace query and weather check in parallel
    const midLat = (origin.lat + destination.lat) / 2;
    const midLon = (origin.lon + destination.lon) / 2;

    const [airspace, weather] = await Promise.all([
      queryAirspace(origin, destination, bufferMeters, floor, ceil, flightStart),
      getWeatherStatus(midLat, midLon, flightStart),
    ]);

    return res.json({
      safe_airspace:      airspace.safe_airspace,
      corridor:           airspace.corridor,
      restrictions:       airspace.restrictions,
      weather_restricted: weather.restricted,
      weather_reason:     weather.reason ?? null,
      data_freshness:     lastSynced,
      start_time:         flightStart.toISOString(),
    });

  } catch (err: any) {
    console.error("Scan error:", err);
    return res.status(500).json({ error: err.message });
  }
}