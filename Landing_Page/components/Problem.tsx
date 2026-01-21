export default function Problem() {
  return (
    <section className="h-screen flex flex-col justify-center items-start px-12 space-y-6 bg-gray-100">
      <h2 className="text-3xl font-bold">The Problem</h2>
      <ul className="list-disc ml-6 space-y-2 text-lg">
        <li>Flight planning is slow and error-prone</li>
        <li>Legal airspace regulations are complex</li>
        <li>Multiple platforms make integration hard</li>
      </ul>
    </section>
  )
}
