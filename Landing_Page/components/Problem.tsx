export default function Problem() {
  return (
    <section className="min-h-[80vh] flex flex-col justify-center px-12 bg-primary">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-semibold text-textPrimary mb-6">
          The Challenge for Autonomous Operators
        </h2>
        <p className="text-lg md:text-xl text-textSecondary mb-4">
          Commercial drone and autonomous flight operators face complex airspace regulations, dynamic flight restrictions, and operational risks that slow innovation.
        </p>
        <p className="text-lg md:text-xl text-textSecondary">
          Manual checking of NOTAMs, NFZs, and FAA restrictions wastes valuable time and increases the risk of regulatory violations.
        </p>
      </div>
    </section>
  );
}
