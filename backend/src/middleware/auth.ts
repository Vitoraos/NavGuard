import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db.js";

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const key = req.headers["x-api-key"];
  if (!key)
    return res.status(401).json({ error: "API key required" });

  const { rows } = await pool.query(
    "SELECT id FROM api_keys WHERE key = $1 AND active = true",
    [key]
  );

  if (!rows.length)
    return res.status(403).json({ error: "Invalid API key" });

  next();
}