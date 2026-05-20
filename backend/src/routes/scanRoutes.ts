import { Router } from "express";
import { scanHandler } from "../controllers/scanController.js";
import { requireApiKey } from "../middleware/auth.js";

const router = Router();

/**
 * POST /api/scan
 * Headers:
 *   x-api-key: string (required)
 * Body:
 *   origin:           { lat: number, lon: number }
 *   destination:      { lat: number, lon: number }
 *   buffer_km?:       number (1-50, default 10)
 *   altitude_floor?:  number (feet, default 0)
 *   altitude_ceiling?: number (feet, default 4000)
 *   start_time:       ISO 8601 string
 *
 * Returns:
 *   safe_airspace:      GeoJSON Polygon — where you CAN fly
 *   corridor:           GeoJSON Polygon — your buffered flight path
 *   restrictions:       GeoJSON Feature[] — what was subtracted and why
 *   weather_restricted: boolean
 *   weather_reason:     string | null
 *   data_freshness:     ISO timestamp of last FAA sync
 *   start_time:         ISO string
 */
router.post("/scan", requireApiKey, scanHandler);

export default router;