// backend/src/controllers/scanController.ts
// All grilling decisions baked in:
// - Haversine flight duration estimation (no user input needed)
// - queryAirspace + queryWeatherTimeline run in parallel
// - TFR staleness → hard 503
// - Weather staleness → soft warning, never blocks
// - path_connected = false → 422 with restricted_windows + safe_fragments
// - path_connected = true → 200 with restricted_windows + optional timeline
// - Timeline optional via ?include_timeline=true

import { Request, Response } from "express";
import { queryAirspace, queryWeatherTimeline } from "../services/ruleService";
import { getWeatherFreshness } from "../services/weatherService";
import { isValidLatLon, isValidAltitude, isValidBuffer } from "../utils/validators";
import { parseFlightTime } from "../utils/time";
import { pool } from "../config/db";

// ─── Flight duration estimator ────────────────────────────────────────────────
// Computes estimated flight time from corridor distance.
// Drone speed: 48 km/h (30 mph) conservative commercial default.
// Buffer:      1.5x for takeoff, landing, wind, route deviations.
// Floor:       15 min — minimum window for any flight.
// Ceiling:     120 min — cap for very long corridors.

const DRONE_SPEED_KMH  = 48;
const DURATION_BUFFER  = 1.5;
const MIN_DURATION_MIN = 15;
const MAX_DURATION_MIN = 120;

function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R    = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function estimateFlightMinutes(
  origin:      { lat: number; lon: number },
  destination: { lat: number; lon: number }
): number {
  const distKm     = haversineKm(origin.lat, origin.lon, destination.lat, destination.lon);
  const rawMinutes = (distKm / DRONE_SPEED_KMH) * 60 * DURATION_BUFFER;
  return Math.max(
    MIN_DURATION_MIN,
    Math.min(MAX_DURATION_MIN, Math.ceil(rawMinutes))
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function scanHandler(req: Request, res: Response) {
  try {
    const {
      origin, destination,
      buffer_km, altitude_floor, altitude_ceiling,
      start_time,
    } = req.body;

    const includeTimeline = req.query.include_timeline === "true";

    // ── Input validation ──────────────────────────────────────────────────

    if (!isValidLatLon(origin) || !isValidLatLon(destination))
      return res.status(400)on({ error: "Invalid coordinates" });

    const floor = Number(altitude_floor ?? 0);
    const ceil  = Number(altitude_ceiling ?? 400);
    if (!isValidAltitude(floor, ceil))
      return res.status(400)on({ error: "Invalid altitude range" });

    const bufferMeters = Math.min(Math.max(Number(buffer_km ?? 10), 1), 50) * 1000;
    if (!isValidBuffer(bufferMeters))
      return res.status(400)on({ error: "Invalid buffer size" });

    const flightStart = parseFlightTime(start_time);
    if (!flightStart)
      return res.status(400)on({ error: "Invalid ISO 8601 start_time" });

    // ── Estimate flight window from distance ──────────────────────────────
    // No need to ask users — computable from corridor length

    const estimatedMinutes  = estimateFlightMinutes(origin, destination);
    const estimatedSeconds  = estimatedMinutes * 60;
    const flightEnd         = new Date(
      flightStart.getTime() + estimatedMinutes * 60 * 1000
    );

    // ── TFR freshness — hard block ────────────────────────────────────────
    // Stale TFR data can produce false negatives (safe when restricted).
    // Never serve potentially wrong airspace data — return 503.

    const { rows: tfrRows } = await pool.query(
      "SELECT MAX(last_synced) AS synced FROM nfz_zones"
    );
    const tfrLastSynced = tfrRows[0]?.synced;
    const tfrStale = !tfrLastSynced ||
      Date.now() - new Date(tfrLastSynced).getTime() > 15 * 60 * 1000;

    if (tfrStale) {
      return res.status(503)on({
        error:       "airspace_data_stale",
        last_synced: tfrLastSynced ?? null,
        message:     "TFR data older than 15 minutes. Do not use for active flight planning.",
      });
    }

    // ── Weather freshness — soft warning ──────────────────────────────────
    // Stale weather never blocks. It's included in the response so operators
    // can decide whether to trust the weather zones.

    const weatherFreshness = await getWeatherFreshness();

    // ── Main computation — parallel ───────────────────────────────────────
    // queryAirspace:        corridor → TFR + weather zones → safe polygon + connectivity
    // queryWeatherTimeline: per-minute spatiotemporal weather matching along flight path

    const [airspace, weatherTimeline] = await Promise.all([
      queryAirspace(
        origin, destination,
        bufferMeters, floor, ceil,
        flightStart, flightEnd
      ),
      queryWeatherTimeline(
        origin, destination,
        flightStart, estimatedSeconds
      ),
    ]);

    const flightWindow = {
      start:             flightStart.toISOString(),
      end:               flightEnd.toISOString(),
      estimated_minutes: estimatedMinutes,
    };

    // ── 422 — Disconnected safe airspace ──────────────────────────────────
    // Weather or TFR cuts through the middle of the corridor.
    // Safe space exists but origin and destination are in different pieces.
    // Operator cannot fly — show them where the gap is and why.

    if (!airspace.path_connected) {
      return res.status(422)on({
        error:  "flight_path_blocked",
        reason: "Airspace or weather restriction creates disconnected safe space. No flyable path exists between origin and destination.",
        restricted_windows: weatherTimeline.restricted_windows,
        safe_fragments:     airspace.safe_fragments,  // MultiPolygon pieces for visualisation
        corridor:           airspace.corridor,
        no_fly: {
          regulatory: airspace.no_fly.regulatory,
          weather:    airspace.no_fly.weather,
        },
        flight_window: flightWindow,
        weather: {
          data_freshness: weatherFreshness.last_synced,
          stale:          weatherFreshness.stale,
          stale_minutes:  weatherFreshness.stale_minutes,
        },
        data: {
          tfr_last_synced: tfrLastSynced,
        },
      });
    }

    // ── 200 — Connected safe airspace ─────────────────────────────────────
    // Safe space is connected. Origin and destination are in the same polygon.
    // Operator's flight planning software or autopilot routes through safe_airspace.
    // restricted_windows tells them WHEN and WHY certain areas were cut.
    // Timeline is optional — include via ?include_timeline=true.

    return res.status(200)on({
      // Primary output — the flyable polygon
      safe_airspace: airspace.safe_airspace,

      // Operational corridor (buffered polyline input)
      corridor: airspace.corridor,

      // NO-FLY breakdown by source
      no_fly: {
        regulatory: airspace.no_fly.regulatory,
        weather:    airspace.no_fly.weather,
      },

      // Individual TFR/NFZ features with metadata
      restrictions: airspace.restrictions,

      // Connectivity confirmed
      path_connected: true,

      // Weather restrictions along the path — WHEN and WHY
      has_weather_warning:  weatherTimeline.restricted_windows.length > 0,
      restricted_windows:   weatherTimeline.restricted_windows,

      // Per-minute timeline — optional, premium surface
      // Enable via ?include_timeline=true
      ...(includeTimeline && { timeline: weatherTimeline.timeline }),

      // Flight window — computed, not user-provided
      flight_window: flightWindow,

      // Weather data provenance
      weather: {
        data_freshness: weatherFreshness.last_synced,
        stale:          weatherFreshness.stale,
        stale_minutes:  weatherFreshness.stale_minutes,
      },

      // Data provenance
      data: {
        tfr_last_synced: tfrLastSynced,
      },
    });

  } catch (err: any) {
    console.error("Scan error:", err);
    return res.status(500)on({ error: err.message });
  }
}
