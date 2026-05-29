import express from "express";
import scanRoutes from "./routes/scanRoutes";

const app = express();

// Middleware
app.use(express.json());

// Routes
app.use("/api", scanRoutes);

// Health check
app.get("/health", (_req, res) => {
 res.json({ status: "ok", message: "Drone Compliance Core Backend is alive" });

export default app;
