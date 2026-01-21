// pages/index.tsx
import Hero from '../components/Hero';
import Problem from '../components/Problem';
import Solution from '../components/Solution';
import HowItWorks from '../components/HowItWorks';
import Features from '../components/Features';
import Benefits from '../components/Benefits';
import Example from '../components/Example';
import CTA from '../components/CTA';
import Footer from '../components/Footer';

export default function Home() {
  return (
    <div className="bg-primary-background text-primary-text">
      <Hero />
      <Problem />
      <Solution />
      <HowItWorks />
      <Features />
      <Benefits />
      <Example />
      <CTA />
      <Footer />
    </div>
  );
}
