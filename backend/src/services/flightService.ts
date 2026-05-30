import { pool } from "../config/db";
import { queryWeatherTimeline } from "./ruleService";

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

const DRONE_SPEED_KMH  = 48;
const DURATION_BUFFER  = 1.5;
const MIN_DURATION_MIN = 5;
const MAX_DURATION_MIN = 120;

function estimateRemainingSeconds(
current:     { lat: number; lon: number },
destination: { lat: number; lon: number }
): number {
const distKm     = haversineKm(current.lat, current.lon, destination.lat, destination.lon);
const rawMinutes = (distKm / DRONE_SPEED_KMH) * 60 * DURATION_BUFFER;
const minutes    = Math.max(MIN_DURATION_MIN, Math.min(MAX_DURATION_MIN, Math.ceil(rawMinutes)));
return minutes * 60;
}

async function checkInsideSafeAirspace(
current:         { lat: number; lon: number },
flightSessionId: string
): Promise<{ inside: boolean; new_tfr_hit: boolean; tfr_name: string | null }> {
const { rows: safeRows } = await pool.query(`SELECT ST_Within( ST_SetSRID(ST_MakePoint($1, $2), 4326), safe_airspace ) AS inside FROM flight_sessions WHERE id = $3 AND safe_airspace IS NOT NULL`, [current.lon, current.lat, flightSessionId]);
const insideStored = safeRows[0]?.inside ?? true;
const { rows: tfrRows } = await pool.query(`SELECT id, name FROM nfz_zones WHERE ST_Within(ST_SetSRID(ST_MakePoint($1, $2), 4326), geom) AND start_time >= (SELECT created_at FROM flight_sessions WHERE id = $3) AND (end_time IS NULL OR end_time > NOW()) LIMIT 1`, [current.lon, current.lat, flightSessionId]);
const newTfrHit = tfrRows.length > 0;
return {
inside:      insideStored && !newTfrHit,
new_tfr_hit: newTfrHit,
tfr_name:    newTfrHit ? tfrRows[0].name : null,
};
}

interface PositionWeather {
restricted:  boolean;
wind_mph:    number;
precip:      number;
visibility:  number;
reasons:     string[];
}

async function getWeatherAtPosition(
current: { lat: number; lon: number }
): Promise<PositionWeather> {
const { rows } = await pool.query(`SELECT restricted, wind_mph, precip, visibility FROM weather_grid WHERE fetched_at > NOW() - INTERVAL '40 minutes' ORDER BY ST_Distance( ST_Transform(geom, 3857), ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3857) ) LIMIT 1`, [current.lon, current.lat]);
if (!rows.length)
return { restricted: false, wind_mph: 0, precip: 0, visibility: 9999, reasons: [] };
const r       = rows[0];
const reasons: string[] = [];
if (r.wind_mph > 25)     reasons.push(`Wind ${r.wind_mph.toFixed(1)} mph exceeds 25 mph limit`);
if (r.precip > 2)        reasons.push(`Precipitation ${r.precip.toFixed(1)} mm/hr exceeds limit`);
if (r.visibility < 1000) reasons.push(`Visibility ${r.visibility}m below 1000m minimum`);
return {
restricted:  r.restricted,
wind_mph:    r.wind_mph,
precip:      r.precip,
visibility:  r.visibility,
reasons,
};
}

async function pushAlert(monitorSessionId: string, alert: object): Promise<void> {
await pool.query(`UPDATE weather_monitor_sessions SET last_snapshot = last_snapshot || $2::jsonb WHERE id = $1`, [monitorSessionId, JSON.stringify({ position_alert: alert, alerted_at: new Date().toISOString() })]);
}

export interface PositionCheckResult {
safe:                 boolean;
inside_safe_airspace: boolean;
new_tfr_activated:    boolean;
tfr_name:             string | null;
current_weather:      PositionWeather;
remaining_minutes:    number;
restricted_windows:   object[];
path_weather_safe:    boolean;
alert_pushed:         boolean;
}

export async function checkDronePosition(
flightSessionId:  string,
monitorSessionId: string | null,
current:          { lat: number; lon: number },
destination:      { lat: number; lon: number }
): Promise<PositionCheckResult> {
const remainingSeconds = estimateRemainingSeconds(current, destination);
const remainingMinutes = Math.ceil(remainingSeconds / 60);
const [safeAirspaceCheck, currentWeather, timeline] = await Promise.all([
checkInsideSafeAirspace(current, flightSessionId),
getWeatherAtPosition(current),
queryWeatherTimeline(current, destination, new Date(), remainingSeconds),
]);
const insideSafe  = safeAirspaceCheck.inside;
const overallSafe = insideSafe && !currentWeather.restricted && timeline.path_weather_safe;
let alertPushed = false;
if (!overallSafe && monitorSessionId) {
await pushAlert(monitorSessionId, {
type:                 "position_check_alert",
inside_safe_airspace: insideSafe,
new_tfr_activated:    safeAirspaceCheck.new_tfr_hit,
tfr_name:             safeAirspaceCheck.tfr_name,
current_weather:      currentWeather,
restricted_windows:   timeline.restricted_windows,
current_position:     current,
remaining_minutes:    remainingMinutes,
});
alertPushed = true;
}
return {
safe:                 overallSafe,
inside_safe_airspace: insideSafe,
new_tfr_activated:    safeAirspaceCheck.new_tfr_hit,
tfr_name:             safeAirspaceCheck.tfr_name,
current_weather:      currentWeather,
remaining_minutes:    remainingMinutes,
restricted_windows:   timeline.restricted_windows,
path_weather_safe:    timeline.path_weather_safe,
alert_pushed:         alertPushed,
};
}
