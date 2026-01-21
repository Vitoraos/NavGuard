import React from "react";
import Head from "next/head";

const DocsPage = () => {
  return (
    <>
      <Head>
        <title>Drone Compliance API Docs</title>
        <meta name="description" content="Drone Compliance API documentation for startups and developers." />
      </Head>

      <main className="max-w-5xl mx-auto px-6 py-12 space-y-16">
        {/* Header */}
        <h1 className="text-4xl font-bold text-center text-gray-900">
          Drone Compliance API Documentation
        </h1>

        {/* What the API does */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-gray-800">What the API Does</h2>
          <p className="text-gray-700">
            Our API provides real-time restricted airspace data for drones. You submit a flight path and it returns:
          </p>
          <ul className="list-disc list-inside text-gray-700">
            <li>Intersections with No-Fly Zones (NFZ) or Temporary Flight Restrictions (TFRs)</li>
            <li>Buffer zones around your path for safe clearance</li>
            <li>Applicable rules based on altitude and flight time</li>
          </ul>
        </section>

        {/* Input Format */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-gray-800">Input Format</h2>
          <p className="text-gray-700">
            Provide your flight path with origin & destination coordinates, altitude range, buffer, and start time.
          </p>
          <pre className="bg-gray-100 p-4 rounded-md overflow-x-auto text-sm">
{`{
  "origin": { "lat": 6.5244, "lon": 3.3792 },
  "destination": { "lat": 6.5350, "lon": 3.4100 },
  "altitude_floor": 0,
  "altitude_ceiling": 400,
  "buffer_km": 5,
  "start_time": "2026-01-20T14:00:00Z"
}`}
          </pre>
          <p className="text-gray-600 text-sm">
            <strong>Notes:</strong> `start_time` must be ISO 8601.
          </p>
        </section>

        {/* Output Format */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-gray-800">Output Format</h2>
          <p className="text-gray-700">The API returns:</p>
          <ul className="list-disc list-inside text-gray-700">
            <li><code>polyline</code>: The submitted path.</li>
            <li><code>buffer</code>: Polygon representing buffered area.</li>
            <li><code>rules</code>: Array of intersecting NFZ/TFR zones with metadata.</li>
            <li><code>start_time</code>: Normalized flight start time in ISO 8601.</li>
          </ul>
          <pre className="bg-gray-100 p-4 rounded-md overflow-x-auto text-sm">
{`{
  "polyline": {...},
  "buffer": {...},
  "rules": [...],
  "start_time": "2026-01-20T14:00:00.000Z"
}`}
          </pre>
        </section>

        {/* Error Codes */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-gray-800">Error Codes & Solutions</h2>
          <ul className="list-disc list-inside text-gray-700">
            <li><strong>400: Invalid coordinates</strong> - Check latitude/longitude format.</li>
            <li><strong>400: Invalid altitude range</strong> - Ensure floor ≤ ceiling.</li>
            <li><strong>400: Invalid buffer size</strong> - Must be 1-50 km.</li>
            <li><strong>400: Invalid ISO 8601 start_time</strong> - Correct date format.</li>
            <li><strong>500: Server error</strong> - Retry or contact support.</li>
          </ul>
        </section>

        {/* Benefits */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-gray-800">Why Use This API?</h2>
          <ul className="list-disc list-inside text-gray-700">
            <li>Save hours in flight planning with real-time NFZ/TFR detection</li>
            <li>Ensure legal compliance and reduce operational risk</li>
            <li>Integrate quickly into your drone software or fleet management platform</li>
            <li>Supports multi-flight updates and batch requests</li>
          </ul>
        </section>

        {/* Example Apps (Optional / Skippable) */}
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold text-gray-800">Applications</h2>
          <p className="text-gray-700">
            Build:
          </p>
          <ul className="list-disc list-inside text-gray-700">
            <li>Autonomous flight planning software</li>
            <li>Fleet optimization platforms</li>
            <li>Simulation and training apps for drones</li>
            <li>Operational compliance dashboards</li>
          </ul>
        </section>
      </main>
    </>
  );
};

export default DocsPage;
