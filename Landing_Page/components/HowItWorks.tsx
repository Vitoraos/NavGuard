export default function HowItWorks() {
  return (
    <section className="min-h-[80vh] flex flex-col justify-center px-12 bg-primary">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-semibold text-textPrimary mb-6">
          How NavGuard Works
        </h2>
        <ol className="list-decimal pl-6 text-lg md:text-xl text-textSecondary space-y-3">
          <li>Provide your flight origin and destination coordinates, proposed flight start time,  and altitudes floor and ceiling.</li>
          <li>NavGuard queries regulatory databases in real-time.</li>
          <li>Receive intersecting NFZs, flight restrictions, and TFRs etc [Any Airspace restricted by FAA. Note: this does not cover local ordinances. coming soon...].</li>
          <li>Optimize your autonomous operations while staying compliant.</li>
        </ol>
      </div>
    </section>
  );
}
