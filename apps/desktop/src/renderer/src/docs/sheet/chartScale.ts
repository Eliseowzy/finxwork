// Axis ticks for a chart: round numbers that cover the data.

export function niceTicks(lo: number, hi: number, want = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) {
    if (lo === 0) return [0, 1];
    hi = lo > 0 ? lo * 2 : 0;
    lo = lo > 0 ? 0 : lo * 2;
  }
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const first = Math.floor(lo / step + 1e-9);
  const last = Math.ceil(hi / step - 1e-9);
  const out: number[] = [];
  for (let i = first; i <= last && out.length < 50; i++) out.push(Math.round(i * step * 1e9) / 1e9);
  return out;
}
