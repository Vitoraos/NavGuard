import { Feature, LineString, Polygon } from "geojson";

export function makePolylineGeoJSON(origin: any, destination: any): Feature<LineString> {
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

export function bufferPolyline(polyline: Feature<LineString>, meters: number): Feature<Polygon> {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [] // actual buffer done in PostGIS
    },
    properties: {
      polyline,
      meters
    }
  };
}
