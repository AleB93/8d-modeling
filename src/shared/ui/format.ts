/** Compact number for UI labels: 950 → "950", 1234 → "1.2k". */
export const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.round(n).toString());
