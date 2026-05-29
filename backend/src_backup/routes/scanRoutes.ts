// backend/src/routes/scanRoutes.ts

import { Router } from "express";
import { scanHandler } from "../controllers/scanController";
import { zonesHandler, zonesStreamHandler } from "../controllers/zonesController";
import { startFlight, updatePosition, endFlight } from "../controllers/flightController";
import { requireApiKey } from "../middleware/auth";

const router = Router();

// Pre-flight airspace scan
router.post("/scan", requireApiKey, scanHandler);

// Weather zone monitoring (SSE)
router.post("/zones",                   requireApiKey, zonesHandler);
router.get("/zones/stream/:sessionId",  requireApiKey, zonesStreamHandler);

// In-flight position tracking
router.post(  "/flight/start",          requireApiKey, startFlight);
router.post(  "/flight/:id/position",   requireApiKey, updatePosition);
router.delete("/flight/:id",            requireApiKey, endFlight);

export default router;
