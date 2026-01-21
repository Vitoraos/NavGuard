export default function Header() {
  return (
    <header className="flex justify-between items-center py-6 px-8 bg-secondary text-white fixed w-full z-50">
      <div className="text-xl font-bold">DroneAPI</div>
      <a href="#cta" className="bg-primary px-4 py-2 rounded text-white font-semibold hover:bg-blue-700 transition">
        Get Access
      </a>
    </header>
  )
}
