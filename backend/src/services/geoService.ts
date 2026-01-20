import { Feature, LineString, Polygon } from "geojson";

/**
 * Create a GeoJSON LineString from origin and destination coordinates
 */
export function makePolylineGeoJSON(
  origin: { lat: number; lon: number },
  destination: { lat: number; lon: number }
): Feature<LineString> {
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

/**
 * Prepare a GeoJSON object for buffering in PostGIS
 * The 'meters' value is stored in properties for your SQL to read
 */
export function bufferPolyline(
  polyline: Feature<LineString>,
  meters: number
): Feature<Polygon> {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [] // Actual buffer is applied in PostGIS using ST_Buffer
    },
    properties: {
      polyline,
      meters
    }
  };
}
