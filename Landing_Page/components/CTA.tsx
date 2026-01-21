import { useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

export default function CTA() {
  const [status, setStatus] = useState("");
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = {
      name: form.get("name"),
      email: form.get("email"),
      company: form.get("company"),
      phone: form.get("phone"),
    };

    const res = await fetch("/api/captureLead", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });

    if (res.ok) {
      setStatus("Thank you! Redirecting to documentation...");
      setTimeout(() => {
        router.push("/docs");
      }, 1500);
    } else {
      setStatus("Something went wrong. Please try again.");
    }
  };

  return (
    <section id="cta" className="min-h-[80vh] flex flex-col justify-center px-12 bg-primary">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-3xl md:text-4xl font-semibold text-textPrimary mb-6">Get Access to NavGuard API</h2>
        <p className="text-lg md:text-xl text-textSecondary mb-6">
          Fill out the form below to access full API documentation.
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col space-y-4">
          <input name="name" placeholder="Full Name" className="p-3 rounded bg-[#0F1A2B] border-b-2 border-accent text-textPrimary" required />
          <input name="email" type="email" placeholder="Email" className="p-3 rounded bg-[#0F1A2B] border-b-2 border-accent text-textPrimary" required />
          <input name="company" placeholder="Company" className="p-3 rounded bg-[#0F1A2B] border-b-2 border-accent text-textPrimary" />
          <input name="phone" placeholder="Phone" className="p-3 rounded bg-[#0F1A2B] border-b-2 border-accent text-textPrimary" />
          <button type="submit" className="bg-gradient-to-r from-accent to-secondary text-primary font-semibold px-6 py-3 rounded-lg shadow-glow hover:scale-105 transition-transform">
            Access Docs
          </button>
        </form>
        {status && <p className="mt-4 text-textSecondary">{status}</p>}
      </div>
    </section>
  );
}
