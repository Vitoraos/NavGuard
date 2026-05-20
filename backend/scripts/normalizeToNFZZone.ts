// scripts/normalizeToNFZZone.ts
// Adapter layer — converts any data source into a consistent NFZZone shape.
// When you switch from AeroAPI to FAA NOTAM API later, only the fetch/parse
// layer changes. This file and everything downstream stays identical.

import { Geometry } from "geojson";

export type ZoneType = "TFR" | "NFZ" | "NOTAM";

export interface NFZZone {
  external_id: string;
  name: string;
  reason: string | null;
  source: string;
  type: ZoneType;
  altitude_floor: number;
  altitude_ceiling: number;
  start_time: Date | null;
  end_time: Date | null;
  geom: Geometry;
}

interface AeroAPITFR {
  tfr_id: string;
  name?: string;
  reason?: string;
  type?: string;
  altitude_lower?: { value: number; units: string };
  altitude_upper?: { value: number; units: string };
  effective_start?: string;
  effective_end?: string;
  geometry?: Geometry;
  center?: { latitude: number; longitude: number };
  radius_nm?: number;
}

function toFeet(value: number, units: string): number {
  if (!units) return value;
  const u = units.toUpperCase();
  if (u === "FL") return value * 100;
  if (u === "M")  return value * 3.281;
  return value;
}

function circleToPolygon(lat: number, lon: number, radiusNm: number): Geometry {
  const radiusDeg = radiusNm / 60;
  const points = 64;
  const coords: [number, number][] = [];
  for (let i = 0; i <= points; i++) {
    const angle = (i / points) * 2 * Math.PI;
    const dLat = radiusDeg * Math.cos(angle);
    const dLon = (radiusDeg * Math.sin(angle)) / Math.cos((lat * Math.PI) / 180);
    coords.push([lon + dLon, lat + dLat]);
  }
  return { type: "Polygon", coordinates: [coords] };
}

function classifyType(raw?: string): ZoneType {
  if (!raw) return "TFR";
  const t = raw.toUpperCase();
  if (t.includes("NOTAM"))                      return "NOTAM";
  if (t.includes("NFZ") || t.includes("PERMANENT")) return "NFZ";
  return "TFR";
}

export function normalizeAeroAPITFR(tfr: AeroAPITFR): NFZZone | null {
  let geom: Geometry | null = null;

  if (tfr.geometry) {
    geom = tfr.geometry;
  } else if (tfr.center && tfr.radius_nm) {
    geom = circleToPolygon(tfr.center.latitude, tfr.center.longitude, tfr.radius_nm);
  }

  if (!geom) {
    console.warn(`Skipping TFR ${tfr.tfr_id} — no usable geometry`);
    return null;
  }

  const floor   = tfr.altitude_lower ? toFeet(tfr.altitude_lower.value, tfr.altitude_lower.units) : 0;
  const ceiling = tfr.altitude_upper ? toFeet(tfr.altitude_upper.value, tfr.altitude_upper.units) : 18000;

  return {
    external_id:      tfr.tfr_id,
    name:             tfr.name ?? tfr.tfr_id,
    reason:           tfr.reason ?? null,
    source:           "AeroAPI",
    type:             classifyType(tfr.type),
    altitude_floor:   floor,
    altitude_ceiling: ceiling,
    start_time: tfr.effective_start ? new Date(tfr.effective_start) : null,
    end_time:   tfr.effective_end   ? new Date(tfr.effective_end)   : null,
    geom,
  };
}