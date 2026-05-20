import { Router } from "express";
import { scanHandler } from "../controllers/scanController.js";
import { zonesHandler, zonesStreamHandler } from "../controllers/zonesController.js";
import { requireApiKey } from "../middleware/auth.js";

const router = Router();

router.post("/scan", requireApiKey, scanHandler);
router.post("/zones", requireApiKey, zonesHandler);
router.get("/zones/stream/:sessionId", requireApiKey, zonesStreamHandler);

export default router;