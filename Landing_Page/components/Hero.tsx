export default function Hero() {
  return (
    <section className="h-screen flex flex-col justify-center items-start px-12 space-y-6">
      <h1 className="text-5xl font-bold leading-tight max-w-3xl">
        The Easiest Way to Stay Compliant in the Sky
      </h1>
      <p className="text-xl max-w-2xl">
        Instantly check restricted airspace, flight rules, and optimize routes for drones, autonomous vehicles, and marine fleets.
      </p>
      <a href="#cta" className="bg-primary text-white px-6 py-3 rounded-lg font-semibold hover:bg-blue-700 transition mt-4">
        Start Free
      </a>
    </section>
  )
}
