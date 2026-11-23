/** Compact number for UI labels: 950 → "950", 1234 → "1.2k", 2500000 → "2.5M". */
export function fmt(n: number): string {
  const r = Math.round(n);
  if (Math.abs(r) < 1000) return r.toString();
  if (Math.abs(n) < 999_950) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}
