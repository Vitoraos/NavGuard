export function isValidLatLon(v: any) {
  return (
    v &&
    typeof v.lat === "number" &&
    typeof v.lon === "number" &&
    v.lat >= -90 &&
    v.lat <= 90 &&
    v.lon >= -180 &&
    v.lon <= 180
  );
}

export function isValidAltitude(floor: number, ceil: number) {
  return floor >= 0 && ceil >= 0 && floor <= ceil;
}

export function isValidBuffer(meters: number) {
  return meters >= 1000 && meters <= 50000;
}
