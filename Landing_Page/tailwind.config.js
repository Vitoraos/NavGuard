/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./pages/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        primary: "#0F172A",      // Aviation dark
        accent: "#3B82F6",       // Aviation Blue
        secondary: "#22D3EE",    // Radar Cyan
        background: "#050B14",   // Aviation Midnight
        textPrimary: "#E6EDF6",
        textSecondary: "#9FB2CC",
        textMuted: "#6B7C99"
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"]
      },
      spacing: {
        section: "80vh"
      },
      boxShadow: {
        glow: "0 4px 20px rgba(59,130,246,0.4)"
      }
    }
  },
  plugins: []
};
