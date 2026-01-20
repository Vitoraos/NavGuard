import { Feature, LineString, Polygon } from "geojson";
import buffer from "@turf/buffer";
import { lineString } from "@turf/helpers";

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

export function bufferPolyline(
  polyline: Feature<LineString>,
  meters: number
): Feature<Polygon> {

  const turfLine = lineString(polyline.geometry.coordinates);

  const buffered = buffer(turfLine, meters / 1000, {
    units: "kilometers"
  });

  return buffered as Feature<Polygon>;
}
