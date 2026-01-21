import type { NextPage } from "next";
import Head from "next/head";
import Link from "next/link";

const Docs: NextPage = () => {
  return (
    <>
      <Head>
        <title>NavGuard API Documentation</title>
        <meta name="description" content="Full API reference for NavGuard – regulatory intelligence API for drones and autonomous flight" />
      </Head>

      <main className="min-h-screen bg-primary text-textPrimary px-12 py-12 font-inter">
        <h1 className="text-5xl md:text-6xl font-bold mb-6">NavGuard API Documentation</h1>
        <p className="text-xl md:text-2xl text-textSecondary mb-12">
          Real-time regulatory intelligence for autonomous drones and UAM vehicles.
        </p>

        <section className="max-w-5xl space-y-8">
          <h2 className="text-3xl font-semibold mb-4">Endpoint</h2>
          <pre className="bg-[#0F1A2B] p-6 rounded-lg overflow-x-auto text-textSecondary font-mono">
{`POST /api/scan
Content-Type: application/json

{
  "origin": [latitude, longitude],
  "destination": [latitude, longitude],
  "altitude_floor": number (meters),
  "altitude_ceiling": number (meters),
  "start_time": ISO8601 string
}`}
          </pre>

          <h2 className="text-3xl font-semibold mb-4">Response Format</h2>
          <pre className="bg-[#0F1A2B] p-6 rounded-lg overflow-x-auto text-textSecondary font-mono">
{`{
  "polyline": { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [...] }, "properties": {} },
  "buffer": { "type": "Polygon", "coordinates": [...] },
  "rules": [
    {
      "type": "Feature",
      "geometry": { "type": "Polygon", "coordinates": [...] },
      "properties": {
        "id": number,
        "name": string,
        "reason": string,
        "altitude_floor": number,
        "altitude_ceiling": number,
        "source": string,
        "start_time": string | null,
        "end_time": string | null
      }
    }
  ],
  "start_time": "ISO8601 string"
}`}
          </pre>

          <h2 className="text-3xl font-semibold mb-4">Error Handling</h2>
          <ul className="list-disc pl-6 text-textSecondary space-y-2">
            <li><strong>400:</strong> Invalid coordinates, altitude, buffer, or start_time</li>
            <li><strong>500:</strong> Server error – retry or contact support</li>
          </ul>

          <h2 className="text-3xl font-semibold mb-4">Usage Notes</h2>
          <ul className="list-disc pl-6 text-textSecondary space-y-2">
            <li>Integrate by providing origin, destination, altitude floor & ceiling, and start time.</li>
            <li>Batch requests allowed for fleet operations.</li>
            <li>API provides real-time compliance data to avoid restricted airspace.</li>
          </ul>

          <Link href="/">
            <a className="inline-block mt-8 bg-gradient-to-r from-accent to-secondary text-primary font-semibold px-6 py-3 rounded-lg shadow-glow hover:scale-105 transition-transform">
              Back to Landing Page
            </a>
          </Link>
        </section>
      </main>
    </>
  );
};

export default Docs;
