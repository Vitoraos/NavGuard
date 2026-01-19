import { Feature, LineString, Polygon } from "geojson";
import turf from "@turf/turf";

export function makePolylineGeoJSON(origin: { lat: number, lon: number }, destination: { lat: number, lon: number }): Feature<LineString> {
  return {
    type: "Feature",
    geometry: {
      type: "LineString",
      coordinates: [
        [origin.lon, origin.lat],
        [destination.lon, destination.lat]
      ]
    },
    properties: {}
  };
}

export function bufferPolyline(polyline: Feature<LineString>, bufferMeters: number): Feature<Polygon> {
  return turf.buffer(polyline, bufferMeters, { units: "meters" }) as Feature<Polygon>;
}
