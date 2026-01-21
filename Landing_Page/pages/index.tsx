import Header from '../components/Header'
import Hero from '../components/Hero'
import Problem from '../components/Problem'
import Solution from '../components/Solution'
import HowItWorks from '../components/HowItWorks'
import Features from '../components/Features'
import Example from '../components/Example'
import Benefits from '../components/Benefits'
import CTA from '../components/CTA'
import Footer from '../components/Footer'

export default function Home() {
  return (
    <div className="bg-light text-gray-900">
      <Header />
      <main className="space-y-32">
        <Hero />
        <Problem />
        <Solution />
        <HowItWorks />
        <Features />
        <Example />
        <Benefits />
        <CTA />
      </main>
      <Footer />
    </div>
  )
}
