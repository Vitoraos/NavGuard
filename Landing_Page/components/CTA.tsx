import { useState } from 'react';
import { useRouter } from 'next/router';

export default function CTA() {
  const [status, setStatus] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = {
      name: form.get('name'),
      email: form.get('email'),
      company: form.get('company'),
      phone: form.get('phone')
    };
    const res = await fetch('/api/captureLead', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' }
    });

    if (res.ok) {
      setStatus('Lead captured successfully!');
      setSubmitted(true); // Show the redirect button
    } else {
      setStatus('Something went wrong. Please try again.');
    }
  };

  const goToDocs = () => {
    router.push('/docs'); // Redirect to docs
  };

  return (
    <section id="cta" className="h-screen flex flex-col justify-center items-start px-12 space-y-6 bg-primary text-white">
      <h2 className="text-3xl font-bold">Get Started Now</h2>
      <p className="text-lg max-w-2xl">Fill the form and access full API documentation immediately.</p>

      {!submitted ? (
        <form className="flex flex-col space-y-4 mt-4 w-full max-w-md" onSubmit={handleSubmit}>
          <input name="name" placeholder="Full Name" className="p-3 rounded text-black" required />
          <input name="email" type="email" placeholder="Email" className="p-3 rounded text-black" required />
          <input name="company" placeholder="Company" className="p-3 rounded text-black" />
          <input name="phone" placeholder="Phone" className="p-3 rounded text-black" />
          <button
            type="submit"
            className="bg-accent text-black font-bold py-3 rounded hover:opacity-90 transition"
          >
            Submit
          </button>
        </form>
      ) : (
        <button
          onClick={goToDocs}
          className="mt-4 bg-accent text-black font-bold py-3 px-6 rounded hover:opacity-90 transition"
        >
          Go to Documentation
        </button>
      )}

      {status && <p className="mt-4">{status}</p>}
    </section>
  );
}
