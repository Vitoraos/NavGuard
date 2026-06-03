import { Request, Response } from "express";
import { queryAirspace, queryWeatherTimeline } from "../services/ruleService";
import { getWeatherFreshness } from "../services/weatherService";
import { isValidLatLon, isValidAltitude, isValidBuffer } from "../utils/validators";
import { parseFlightTime } from "../utils/time";
import { pool } from "../config/db";
import { auditLog } from "../services/auditService";

const DRONE_SPEED_KMH       = 48;
const DURATION_BUFFER       = 1.5;
const MIN_DURATION_MIN      = 15;
const MAX_DURATION_MIN      = 120;
const CONTINGENCY_BUFFER_M  = 500; // Fixed 500m buffer around contingency landing point

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
  return Math.max(MIN_DURATION_MIN, Math.min(MAX_DURATION_MIN, Math.ceil(rawMinutes)));
}

// BUILD-02: check a contingency landing point against live airspace and weather
async function checkContingencyPoint(
  point:        { lat: number; lon: number },
  floor:        number,
  ceil:         number,
  flightStart:  Date,
  flightEnd:    Date,
  thresholds:   { max_wind_mph: number; max_precip: number; min_visibility: number }
): Promise<{
  cleared:        boolean;
  restrictions:   object[];
  weather_clear:  boolean;
  no_fly:         { regulatory: object | null; weather: object | null };
}> {
  const result = await queryAirspace(
    point,              // origin = landing point
    point,              // destination = same point (point check not line check)
    CONTINGENCY_BUFFER_M,
    floor,
    ceil,
    flightStart,
    flightEnd,
    thresholds
  );

  const weatherTimeline = await queryWeatherTimeline(
    point, point,
    flightStart,
    5 * 60  // 5 minute window — just need to know if landing is safe right now
  );

  return {
    cleared:       result.path_connected && weatherTimeline.restricted_windows.length === 0,
    restrictions:  result.restrictions,
    weather_clear: weatherTimeline.restricted_windows.length === 0,
    no_fly:        result.no_fly,
  };
}

export async function scanHandler(req: Request, res: Response) {
  try {
    const {
      origin, destination,
      buffer_km, altitude_floor, altitude_ceiling,
      start_time,
      thresholds,
      contingency_landing, // BUILD-02: optional { lat, lon }
    } = req.body;
    const apiKeyId       = (req as any).apiKeyId;
    const includeTimeline = req.query.include_timeline === "true";

    if (!isValidLatLon(origin) || !isValidLatLon(destination))
      return res.status(400).json({ error: "Invalid coordinates" });

    const floor = Number(altitude_floor ?? 0);
    const ceil  = Number(altitude_ceiling ?? 400);
    if (!isValidAltitude(floor, ceil))
      return res.status(400).json({ error: "Invalid altitude range" });

    const bufferMeters = Math.min(Math.max(Number(buffer_km ?? 10), 1), 50) * 1000;
    if (!isValidBuffer(bufferMeters))
      return res.status(400).json({ error: "Invalid buffer size" });

    const flightStart = parseFlightTime(start_time);
    if (!flightStart)
      return res.status(400).json({ error: "Invalid ISO 8601 start_time" });

    // BUILD-02: validate contingency point if provided
    if (contingency_landing !== undefined && contingency_landing !== null) {
      if (!isValidLatLon(contingency_landing))
        return res.status(400).json({ error: "contingency_landing must be { lat, lon } with valid coordinates" });
    }

    const estimatedMinutes = estimateFlightMinutes(origin, destination);
    const estimatedSeconds = estimatedMinutes * 60;
    const flightEnd        = new Date(flightStart.getTime() + estimatedMinutes * 60 * 1000);

    const { rows: tfrRows } = await pool.query("SELECT MAX(last_synced) AS synced FROM nfz_zones");
    const tfrLastSynced     = tfrRows[0]?.synced;
    const tfrStale          = !tfrLastSynced ||
      Date.now() - new Date(tfrLastSynced).getTime() > 15 * 60 * 1000;
    if (tfrStale) {
      return res.status(503).json({
        error:       "airspace_data_stale",
        last_synced: tfrLastSynced ?? null,
        message:     "TFR data older than 15 minutes. Do not use for active flight planning.",
      });
    }

    const weatherFreshness  = await getWeatherFreshness();
    const weatherThresholds = {
      max_wind_mph:   thresholds?.max_wind_mph   ?? 25,
      max_precip:     thresholds?.max_precip     ?? 2,
      min_visibility: thresholds?.min_visibility ?? 1000,
    };

    // Run main corridor check and optional contingency check in parallel
    const [airspace, weatherTimeline, contingencyResult] = await Promise.all([
      queryAirspace(origin, destination, bufferMeters, floor, ceil, flightStart, flightEnd, weatherThresholds),
      queryWeatherTimeline(origin, destination, flightStart, estimatedSeconds),
      contingency_landing
        ? checkContingencyPoint(contingency_landing, floor, ceil, flightStart, flightEnd, weatherThresholds)
        : Promise.resolve(null),
    ]);

    const flightWindow = {
      start:             flightStart.toISOString(),
      end:               flightEnd.toISOString(),
      estimated_minutes: estimatedMinutes,
    };

    const contingencyBlock = contingencyResult
      ? {
          cleared:       contingencyResult.cleared,
          restrictions:  contingencyResult.restrictions,
          weather_clear: contingencyResult.weather_clear,
          no_fly:        contingencyResult.no_fly,
        }
      : null;

    if (!airspace.path_connected) {
      const blockedResponse = {
        error:   "flight_path_blocked",
        reason:  "Airspace or weather restriction creates disconnected safe space. No flyable path exists between origin and destination.",
        restricted_windows: weatherTimeline.restricted_windows,
        safe_fragments:     airspace.safe_fragments,
        corridor:           airspace.corridor,
        no_fly:             { regulatory: airspace.no_fly.regulatory, weather: airspace.no_fly.weather },
        flight_window:      flightWindow,
        weather: {
          data_freshness: weatherFreshness.last_synced,
          stale:          weatherFreshness.stale,
          stale_minutes:  weatherFreshness.stale_minutes,
        },
        data:        { tfr_last_synced: tfrLastSynced },
        contingency: contingencyBlock,
      };

      auditLog({
        endpoint: "POST /scan",
        apiKeyId,
        summary: {
          path_connected:       false,
          altitude_floor:       floor,
          altitude_ceiling:     ceil,
          buffer_meters:        bufferMeters,
          restrictions_hit:     airspace.restrictions.length,
          weather_windows_hit:  weatherTimeline.restricted_windows.length,
          data_gaps:            weatherTimeline.data_gaps,
          weather_stale:        weatherFreshness.stale,
          tfr_last_synced:      tfrLastSynced ?? null,
          flight_window:        flightWindow,
          contingency_provided: !!contingency_landing,
          contingency_cleared:  contingencyResult?.cleared ?? null,
        },
        fullResponse: blockedResponse,
      });

      return res.status(422).json(blockedResponse);
    }

    const successResponse = {
      safe_airspace:        airspace.safe_airspace,
      corridor:             airspace.corridor,
      no_fly:               { regulatory: airspace.no_fly.regulatory, weather: airspace.no_fly.weather },
      restrictions:         airspace.restrictions,
      path_connected:       true,
      has_weather_warning:  weatherTimeline.restricted_windows.length > 0,
      restricted_windows:   weatherTimeline.restricted_windows,
      ...(includeTimeline && { timeline: weatherTimeline.timeline }),
      flight_window:        flightWindow,
      weather: {
        data_freshness: weatherFreshness.last_synced,
        stale:          weatherFreshness.stale,
        stale_minutes:  weatherFreshness.stale_minutes,
      },
      data:        { tfr_last_synced: tfrLastSynced },
      contingency: contingencyBlock,
    };

    auditLog({
      endpoint: "POST /scan",
      apiKeyId,
      summary: {
        path_connected:       true,
        altitude_floor:       floor,
        altitude_ceiling:     ceil,
        buffer_meters:        bufferMeters,
        safe_airspace:        airspace.safe_airspace,
        restrictions_hit:     airspace.restrictions.length,
        restriction_names:    airspace.restrictions.map((r: any) => r.properties?.name ?? null).filter(Boolean),
        has_weather_warning:  weatherTimeline.restricted_windows.length > 0,
        weather_windows_hit:  weatherTimeline.restricted_windows.length,
        data_gaps:            weatherTimeline.data_gaps,
        weather_stale:        weatherFreshness.stale,
        tfr_last_synced:      tfrLastSynced ?? null,
        flight_window:        flightWindow,
        contingency_provided: !!contingency_landing,
        contingency_cleared:  contingencyResult?.cleared ?? null,
      },
      fullResponse: successResponse,
    });

    return res.status(200).json(successResponse);

  } catch (err: any) {
    console.error("Scan error:", err);
    return res.status(500).json({ error: err.message });
  }
}
