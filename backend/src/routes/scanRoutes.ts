// backend/src/routes/scanRoutes.ts
import { Router } from "express";
import { scanHandler } from "../controllers/scanController";

const router = Router();

/**
 * POST /scan
 * Body:
 *  {
 *    origin: { lat: number, lon: number },
 *    destination: { lat: number, lon: number },
 *    buffer_km?: number (1-50),
 *    altitude_floor?: number,
 *    altitude_ceiling?: number,
 *    start_time: ISO 8601 string
 *  }
 *
 * Returns:
 *  {
 *    polyline: GeoJSON,
 *    buffer: GeoJSON,
 *    rules: array of GeoJSON features with properties,
 *    start_time: string (ISO),
 *    end_time: string (ISO, +24h)
 *  }
 */
router.post("/scan", scanHandler);

export default router;
