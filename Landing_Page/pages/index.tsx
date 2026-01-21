import type { NextPage } from "next";
import Head from "next/head";
import Hero from "../components/Hero";
import Problem from "../components/Problem";
import Solution from "../components/Solution";
import HowItWorks from "../components/HowItWorks";
import Features from "../components/Features";
import Benefits from "../components/Benefits";
import Example from "../components/Example";
import CTA from "../components/CTA";
import Footer from "../components/Footer";

const Home: NextPage = () => {
  return (
    <>
      <Head>
        <title>NavGuard – Aviation Regulatory Intelligence API</title>
        <meta name="description" content="Real-time compliance and airspace intelligence API for autonomous drones and UAM" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="bg-primary font-inter">
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
    </>
  );
};

export default Home;
