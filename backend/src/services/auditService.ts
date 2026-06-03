// src/services/auditService.ts
// Fire-and-forget audit logger. Never sits in the critical path of a response.
// Stores what NavGuard computed — the safe volume, restrictions hit, weather state —
// without exposing any internal query logic or data pipeline details.

import { createHash } from "crypto";
import { pool } from "../config/db";

export type AuditEndpoint =
  | "POST /scan"
  | "POST /zones"
  | "POST /flight/start"
  | "POST /flight/:id/position"
  | "POST /flight/:id/contingency"
  | "DELETE /flight/:id";

export interface AuditPayload {
  endpoint:          AuditEndpoint;
  apiKeyId:          string | undefined;
  flightSessionId?:  string;
  summary:           object;
  fullResponse:      object;
}

function hashResponse(response: object): string {
  return createHash("sha256")
    .update(JSON.stringify(response))
    .digest("hex");
}

export function auditLog(payload: AuditPayload): void {
  // setImmediate pushes the write out of the response critical path entirely
  setImmediate(async () => {
    try {
      await pool.query(`
        INSERT INTO public.audit_log
          (api_key_id, endpoint, flight_session_id, decision_summary, response_hash, computed_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [
        payload.apiKeyId   ?? null,
        payload.endpoint,
        payload.flightSessionId ?? null,
        JSON.stringify(payload.summary),
        hashResponse(payload.fullResponse),
      ]);
    } catch (err) {
      // Audit failure must never crash the application
      console.error("[audit] Failed to write audit row:", err);
    }
  });
}
