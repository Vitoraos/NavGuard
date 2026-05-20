export async function getWeatherStatus(
  lat: number,
  lon: number,
  time: Date
): Promise<{ restricted: boolean; reason?: string }> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&hourly=windspeed_10m,precipitation,visibility` +
      `&forecast_days=2&timezone=UTC`;

    const res  = await fetch(url);
    const data = await res.json();
    const hour = time.getUTCHours();

    const wind       = data.hourly.windspeed_10m[hour];
    const precip     = data.hourly.precipitation[hour];
    const visibility = data.hourly.visibility[hour];

    if (wind > 25)         return { restricted: true, reason: `Wind ${wind} mph exceeds 25 mph limit` };
    if (precip > 2)        return { restricted: true, reason: `Precipitation ${precip} mm/hr exceeds limit` };
    if (visibility < 1000) return { restricted: true, reason: `Visibility ${visibility}m below 1000m minimum` };

    return { restricted: false };
  } catch {
    return { restricted: false, reason: "Weather data unavailable" };
  }
}