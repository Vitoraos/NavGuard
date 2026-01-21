import Link from "next/link";

export default function Hero() {
  return (
    <section className="min-h-screen flex flex-col justify-center px-12 bg-gradient-radial from-accent/15 via-transparent to-primary relative overflow-hidden">
      <div className="max-w-5xl">
        <h1 className="text-5xl md:text-6xl font-bold text-textPrimary leading-tight mb-6">
          NavGuard – Aviation Regulatory Intelligence API
        </h1>
        <p className="text-xl md:text-2xl text-textSecondary mb-8">
          Instantly check restricted airspace, flight rules, and optimize autonomous flight routes with precision and authority.
        </p>
        <Link href="#cta">
          <a className="inline-block bg-gradient-to-r from-accent to-secondary text-primary font-semibold px-8 py-4 rounded-lg shadow-glow hover:scale-105 transition-transform">
            Get Started
          </a>
        </Link>
      </div>
    </section>
  );
}
