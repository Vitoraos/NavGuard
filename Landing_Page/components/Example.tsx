export default function Example() {
  return (
    <section className="h-screen flex flex-col justify-center items-start px-12 space-y-6 bg-gray-100">
      <h2 className="text-3xl font-bold">Example Request</h2>
      <pre className="bg-white p-4 rounded shadow max-w-3xl">
{`{
  "origin": { "lat": 6.5244, "lon": 3.3792 },
  "destination": { "lat": 6.5350, "lon": 3.4100 },
  "altitude_floor": 0,
  "altitude_ceiling": 400,
  "buffer_km": 5,
  "start_time": "2026-01-20T14:00:00Z"
}`}
      </pre>
    </section>
  )
}
