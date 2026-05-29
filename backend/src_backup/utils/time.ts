export function parseFlightTime(input: string): Date | null {
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d;
}
