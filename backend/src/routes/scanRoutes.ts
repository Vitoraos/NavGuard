import express from "express";
import { requireApiKey } from "../middleware/auth";
import { scanHandler } from "../controllers/scanController";
import { zonesHandler, zonesStreamHandler } from "../controllers/zonesController";
import {
  startFlight,
  updatePosition,
  updateContingency,   // BUILD-02
  endFlight,
} from "../controllers/flightController";
 
const router = express.Router();
 
router.get("/health",                        (_req, res) => res.json({ status: "ok" }));
router.post("/scan",                         requireApiKey, scanHandler);
router.post("/zones",                        requireApiKey, zonesHandler);
router.get("/zones/stream/:sessionId",       requireApiKey, zonesStreamHandler);
router.post("/flight/start",                 requireApiKey, startFlight);
router.post("/flight/:id/position",          requireApiKey, updatePosition);
router.post("/flight/:id/contingency",       requireApiKey, updateContingency);  // BUILD-02
router.delete("/flight/:id",                 requireApiKey, endFlight);
 
export default router;
