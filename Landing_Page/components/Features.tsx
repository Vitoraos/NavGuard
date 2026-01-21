export default function Features() {
  const features = [
    "Real-time airspace compliance checks",
    "FAA NFZ integration",
    "Flight Coordinates and Altitude Validation
    "Can be integrated into Fleet-scale simulation & planning",
  ];

  return (
    <section className="min-h-[80vh] flex flex-col justify-center px-12 bg-[#0F1A2B]">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-semibold text-textPrimary mb-6">Features</h2>
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-6 text-textSecondary text-lg md:text-xl">
          {features.map((f) => (
            <li key={f} className="p-4 bg-primary rounded-lg shadow-glow hover:shadow-lg transition">
              {f}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
