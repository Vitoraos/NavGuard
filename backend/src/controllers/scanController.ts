import { Request, Response } from "express";
import { queryRules } from "../services/ruleService.js";
import { isValidLatLon, isValidAltitude, isValidBuffer } from "../utils/validators";
import { parseFlightTime } from "../utils/time";
import { Feature, LineString } from "geojson";

export async function scanHandler(req: Request, res: Response) {
  try {
    const { origin, destination, buffer_km, altitude_floor, altitude_ceiling, start_time } = req.body;

    // Validate coordinates
    if (!isValidLatLon(origin) || !isValidLatLon(destination)) {
      return res.status(400).json({ error: "Invalid coordinates" });
    }

    // Validate altitudes
    const floor = Number(altitude_floor ?? 0);
    const ceil = Number(altitude_ceiling ?? 4000);
    if (!isValidAltitude(floor, ceil)) {
      return res.status(400).json({ error: "Invalid altitude range" });
    }

    // Validate buffer
    const bufferMeters = Math.min(Math.max(Number(buffer_km ?? 10), 1), 50) * 1000;
    if (!isValidBuffer(bufferMeters)) {
      return res.status(400).json({ error: "Invalid buffer size" });
    }

    // Validate flight start time
    const flightStart = parseFlightTime(start_time);
    if (!flightStart) {
      return res.status(400).json({ error: "Invalid ISO 8601 start_time" });
    }

    // Call SQL-side buffered queryRules
    const rules = await queryRules(
      origin,
      destination,
      bufferMeters,
      floor,
      ceil,
      flightStart
    );

    // Recreate polyline for response
    const polyline: Feature<LineString> = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [origin.lon, origin.lat],
          [destination.lon, destination.lat]
        ]
      },
      properties: {}
    };

    return res.json({
      polyline,
      buffer: { type: "Polygon", coordinates: [] }, // buffer handled in SQL
      rules,
      start_time: flightStart.toISOString()
    });

  } catch (err: any) {
    console.error("Scan error:", err);
    return res.status(500).json({ error: err.message });
  }
}
