import { Request, Response } from "express";
import { makePolylineGeoJSON, bufferPolyline } from "../services/geoService";
import { queryRules } from "../services/ruleService.js";
import { isValidLatLon, isValidAltitude, isValidBuffer } from "../utils/validators";
import { parseFlightTime } from "../utils/time";

export async function scanHandler(req: Request, res: Response) {
  try {
    const { origin, destination, buffer_km, altitude_floor, altitude_ceiling, start_time } = req.body;

    if (!isValidLatLon(origin) || !isValidLatLon(destination)) {
      return res.status(400).json({ error: "Invalid coordinates" });
    }

    const floor = Number(altitude_floor ?? 0);
    const ceil = Number(altitude_ceiling ?? 4000);

    if (!isValidAltitude(floor, ceil)) {
      return res.status(400).json({ error: "Invalid altitude range" });
    }

    const bufferMeters = Math.min(Math.max(Number(buffer_km ?? 10), 1), 50) * 1000;
    if (!isValidBuffer(bufferMeters)) {
      return res.status(400).json({ error: "Invalid buffer size" });
    }

    const flightStart = parseFlightTime(start_time);
    if (!flightStart) {
      return res.status(400).json({ error: "Invalid ISO 8601 start_time" });
    }

    const polyline = makePolylineGeoJSON(origin, destination);
    const buffered = bufferPolyline(polyline, bufferMeters);

    const rules = await queryRules(buffered, floor, ceil, flightStart);

    return res.json({
      polyline,
      buffer: buffered,
      rules,
      start_time: flightStart.toISOString()
    });

  } catch (err: any) {
    console.error("Scan error:", err);
    return res.status(500).json({ error: err.message });
  }
}
