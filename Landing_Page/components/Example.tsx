export default function Example() {
  return (
    <section className="min-h-[80vh] flex flex-col justify-center px-12 bg-[#0B1320]">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-semibold text-textPrimary mb-6">API Example</h2>
        <pre className="bg-primary p-6 rounded-lg overflow-x-auto text-textSecondary font-mono text-sm md:text-base shadow-glow">
{`POST /api/scan
{
  "origin": [3.3795, 6.5245],
  "destination": [3.38, 6.525],
  "altitude_floor": 0,
  "altitude_ceiling": 500,
  "start_time": "2026-01-21T10:00:00Z"
}`}
        </pre>
      </div>
    </section>
  );
}
