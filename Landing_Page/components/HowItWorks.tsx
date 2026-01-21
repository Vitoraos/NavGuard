export default function HowItWorks() {
  return (
    <section className="h-screen flex flex-col justify-center items-start px-12 space-y-6 bg-gray-100">
      <h2 className="text-3xl font-bold">How It Works</h2>
      <ol className="list-decimal ml-6 space-y-2 text-lg">
        <li>Send origin, destination, altitude range, bounding box, and flight time to our API</li>
        <li>Receive buffer zones and restricted areas in GeoJSON</li>
        <li>Integrate into flight planning or simulation software</li>
      </ol>
    </section>
  )
}
