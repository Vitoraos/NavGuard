export default function Benefits() {
  const benefits = [
    "Save hours of manual airspace research per flight",
    "Reduce compliance risks",
    "Enable scalable autonomous operations",
    "Integrate seamlessly with your flight planning software",
  ];

  return (
    <section className="min-h-[80vh] flex flex-col justify-center px-12 bg-primary">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-semibold text-textPrimary mb-6">Benefits</h2>
        <ul className="list-disc pl-6 space-y-3 text-textSecondary text-lg md:text-xl">
          {benefits.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
