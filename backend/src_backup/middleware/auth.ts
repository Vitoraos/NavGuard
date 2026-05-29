import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";

export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const key = req.headers["x-api-key"];
  if (!key)
    return res.status(401)on({ error: "API key required" });

  const { rows } = await pool.query(
    "SELECT id FROM api_keys WHERE key = $1 AND active = true",
    [key]
  );

  if (!rows.length)
    return res.status(403)on({ error: "Invalid API key" });

  next();
}