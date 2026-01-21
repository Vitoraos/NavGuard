export default function Features() {
  return (
    <section className="h-screen flex flex-col justify-center items-start px-12 space-y-6">
      <h2 className="text-3xl font-bold">Features</h2>
      <ul className="list-disc ml-6 space-y-2 text-lg">
        <li>GeoJSON output compatible with Leaflet, Mapbox, and GIS software</li>
        <li>Time-sensitive airspace data</li>
        <li>Altitude floor and ceiling checks</li>
        <li>Rate-limiting and usage tracking</li>
      </ul>
    </section>
  )
}
