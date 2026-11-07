import type { SheetChart } from "@finx/protocol";
import { niceTicks } from "./chartScale";

// A chart drawn on a worksheet, as SVG: shown as the file describes it, not edited (spreadsheet-
// design §4.1). The numbers were read by the kernel from the cells the chart points at.

const PALETTE = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#264478", "#9E480E"];
const FONT = 11;

const fmt = (v: number) => (Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(1).replace("e+", "e") : String(Math.round(v * 1e6) / 1e6));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

type Box = { x: number; y: number; w: number; h: number };

export function ChartView({ chart, width, height }: { chart: SheetChart; width: number; height: number }) {
  const color = (i: number) => (chart.series[i]?.color ? `#${chart.series[i].color}` : PALETTE[i % PALETTE.length]);
  const pieLike = chart.kind === "pie" || chart.kind === "doughnut";
  const sliceColor = (i: number) => PALETTE[i % PALETTE.length];

  // Frame: title on top, legend where the file puts it, the plot in what is left.
  const pad = 10;
  let top = pad;
  let bottom = height - pad;
  let left = pad;
  let right = width - pad;
  const parts: React.ReactNode[] = [];
  if (chart.title) {
    parts.push(
      <text key="title" x={width / 2} y={top + 13} textAnchor="middle" fontSize={14} fontWeight={600} fill="var(--l1)">
        {clip(chart.title, Math.max(8, Math.floor(width / 9)))}
      </text>,
    );
    top += 26;
  }
  const entries = pieLike ? chart.categories.map((c, i) => ({ name: c, color: sliceColor(i) })) : chart.series.map((s, i) => ({ name: s.name ?? `Series ${i + 1}`, color: color(i) }));
  if (chart.legend && entries.length > 0 && !(entries.length === 1 && !pieLike && !chart.series[0].name)) {
    const pos = chart.legend;
    const itemW = Math.min(150, Math.max(60, ...entries.map((e) => e.name.length * 7 + 22)));
    if (pos === "b" || pos === "t") {
      const perRow = Math.max(1, Math.floor((width - 2 * pad) / itemW));
      const rows = Math.ceil(entries.length / perRow);
      const y0 = pos === "b" ? bottom - rows * 18 + 4 : top;
      entries.forEach((e, i) => {
        const inRow = Math.min(perRow, entries.length - Math.floor(i / perRow) * perRow);
        const x = width / 2 - (inRow * itemW) / 2 + (i % perRow) * itemW;
        const y = y0 + Math.floor(i / perRow) * 18;
        parts.push(
          <g key={`lg${i}`}>
            <rect x={x} y={y + 3} width={9} height={9} fill={e.color} />
            <text x={x + 14} y={y + 12} fontSize={FONT} fill="var(--l2)">{clip(e.name, Math.floor(itemW / 7))}</text>
          </g>,
        );
      });
      if (pos === "b") bottom -= rows * 18 + 4;
      else top += rows * 18 + 4;
    } else {
      const w = Math.min(itemW, width * 0.3);
      const x = pos === "l" ? left : right - w;
      const y0 = (top + bottom) / 2 - (entries.length * 18) / 2;
      entries.forEach((e, i) =>
        parts.push(
          <g key={`lg${i}`}>
            <rect x={x} y={y0 + i * 18 + 3} width={9} height={9} fill={e.color} />
            <text x={x + 14} y={y0 + i * 18 + 12} fontSize={FONT} fill="var(--l2)">{clip(e.name, Math.floor(w / 7))}</text>
          </g>,
        ),
      );
      if (pos === "l") left += w + 8;
      else right -= w + 8;
    }
  }
  const area: Box = { x: left, y: top, w: Math.max(10, right - left), h: Math.max(10, bottom - top) };
  const body = pieLike ? pie(chart, area, sliceColor) : chart.kind === "radar" ? radar(chart, area, color) : chart.kind === "scatter" ? scatter(chart, area, color) : cartesian(chart, area, color);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chart.title ?? "chart"} fontFamily="inherit">
      <rect width={width} height={height} fill="var(--sht-bg, #fff)" stroke="var(--sep, #ddd)" rx={4} />
      {parts}
      {body}
    </svg>
  );
}

/** Bars, lines and areas on a category axis and a value axis. */
function cartesian(chart: SheetChart, a: Box, color: (i: number) => string) {
  const n = Math.max(chart.categories.length, ...chart.series.map((s) => s.values.length), 1);
  const stacked = chart.grouping !== "clustered" && chart.kind !== "line";
  const percent = chart.grouping === "percent" && chart.kind !== "line";
  const horizontal = chart.kind === "bar" && chart.horizontal;
  const vals = (s: number, i: number) => chart.series[s].values[i] ?? null;
  // Value extent.
  let lo = 0;
  let hi = 0;
  let any = false;
  const totals: { pos: number; neg: number }[] = Array.from({ length: n }, () => ({ pos: 0, neg: 0 }));
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < chart.series.length; s++) {
      const v = vals(s, i);
      if (v === null) continue;
      any = true;
      if (v >= 0) totals[i].pos += v;
      else totals[i].neg += v;
      if (!stacked) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (stacked) {
      lo = Math.min(lo, totals[i].neg);
      hi = Math.max(hi, totals[i].pos);
    }
  }
  if (percent) {
    lo = 0;
    hi = 1;
  }
  if (chart.kind === "line" && any) {
    // A line does not have to start at zero when the data is far from it, as in Excel.
    const all = chart.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    const mn = Math.min(...all);
    const mx = Math.max(...all);
    if (mn > 0 && mn > (mx - mn) * 2) lo = mn - (mx - mn) * 0.5;
  }
  if (chart.min != null) lo = chart.min;
  if (chart.max != null) hi = chart.max;
  const ticks = niceTicks(lo, hi);
  const vmin = chart.min ?? Math.min(lo, ticks[0]);
  const vmax = chart.max ?? Math.max(hi, ticks[ticks.length - 1]);
  const span = vmax - vmin || 1;

  const labelW = horizontal ? Math.min(a.w * 0.3, Math.max(30, ...chart.categories.map((c) => Math.min(c.length, 18) * 7))) : 0;
  const tickW = horizontal ? 0 : Math.max(...ticks.map((t) => (percent ? `${t * 100}%` : fmt(t)).length)) * 6.5 + 8;
  const plot: Box = horizontal ? { x: a.x + labelW + 6, y: a.y + 4, w: a.w - labelW - 14, h: a.h - 24 } : { x: a.x + tickW, y: a.y + 6, w: a.w - tickW - 6, h: a.h - 30 };
  const along = horizontal ? plot.h : plot.w;
  const slot = along / n;
  // The value axis grows up (or right); categories run left to right (or bottom to top, as in Excel).
  const vpos = (v: number) => (horizontal ? plot.x + ((v - vmin) / span) * plot.w : plot.y + plot.h - ((v - vmin) / span) * plot.h);
  const cpos = (i: number) => (horizontal ? plot.y + plot.h - (i + 0.5) * slot : plot.x + (i + 0.5) * slot);
  const zero = vpos(Math.min(Math.max(0, vmin), vmax));
  const out: React.ReactNode[] = [];
  ticks.forEach((t, k) => {
    if (t < vmin - 1e-9 || t > vmax + 1e-9) return;
    const p = vpos(t);
    const text = percent ? `${Math.round(t * 100)}%` : fmt(t);
    out.push(
      horizontal ? (
        <g key={`t${k}`}>
          <line x1={p} x2={p} y1={plot.y} y2={plot.y + plot.h} stroke="var(--sep, #ddd)" />
          <text x={p} y={plot.y + plot.h + 14} fontSize={FONT} textAnchor="middle" fill="var(--l3)">{text}</text>
        </g>
      ) : (
        <g key={`t${k}`}>
          <line x1={plot.x} x2={plot.x + plot.w} y1={p} y2={p} stroke="var(--sep, #ddd)" />
          <text x={plot.x - 6} y={p + 4} fontSize={FONT} textAnchor="end" fill="var(--l3)">{text}</text>
        </g>
      ),
    );
  });
  // Category labels; thinned when they would overlap.
  const every = Math.max(1, Math.ceil((horizontal ? 16 : Math.max(...chart.categories.map((c) => Math.min(c.length, 12)), 2) * 7 + 6) / slot));
  chart.categories.slice(0, n).forEach((c, i) => {
    if (i % every) return;
    out.push(
      horizontal ? (
        <text key={`c${i}`} x={plot.x - 6} y={cpos(i) + 4} fontSize={FONT} textAnchor="end" fill="var(--l2)">{clip(c, 18)}</text>
      ) : (
        <text key={`c${i}`} x={cpos(i)} y={plot.y + plot.h + 16} fontSize={FONT} textAnchor="middle" fill="var(--l2)">{clip(c, Math.max(2, Math.floor((slot * every) / 7)))}</text>
      ),
    );
  });
  out.push(horizontal ? <line key="ax" x1={zero} x2={zero} y1={plot.y} y2={plot.y + plot.h} stroke="var(--l3)" /> : <line key="ax" x1={plot.x} x2={plot.x + plot.w} y1={zero} y2={zero} stroke="var(--l3)" />);

  const ns = chart.series.length;
  const point = (s: number, i: number, v: number) => (horizontal ? { x: vpos(v), y: cpos(i) } : { x: cpos(i), y: vpos(v) });
  const label = (key: string, x: number, y: number, v: number, anchor: "start" | "middle" | "end" = "middle") =>
    chart.labels && (
      <text key={key} x={x} y={y} fontSize={FONT - 1} textAnchor={anchor} fill="var(--l2)">{fmt(v)}</text>
    );

  if (chart.kind === "bar") {
    const gap = 0.6; // gapWidth 60%: a gap this share of a bar between groups
    const groupW = slot / (1 + gap);
    const barW = stacked ? groupW : groupW / ns;
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      const sum = percent ? totals[i].pos - totals[i].neg || 1 : 1;
      for (let s = 0; s < ns; s++) {
        let v = vals(s, i);
        if (v === null) continue;
        if (percent) v /= sum;
        let from = 0;
        let to = v;
        if (stacked) {
          if (v >= 0) [from, to, pos] = [pos, pos + v, pos + v];
          else [from, to, neg] = [neg, neg + v, neg + v];
        }
        const a0 = vpos(from);
        const a1 = vpos(to);
        const off = stacked ? -groupW / 2 : -groupW / 2 + s * barW;
        // Excel lists series bottom-up in a horizontal chart, as it does categories.
        const o = horizontal && !stacked ? -groupW / 2 + (ns - 1 - s) * barW : off;
        const rect = horizontal ? { x: Math.min(a0, a1), y: cpos(i) + o, width: Math.abs(a1 - a0), height: barW } : { x: cpos(i) + o, y: Math.min(a0, a1), width: barW, height: Math.abs(a1 - a0) };
        out.push(<rect key={`b${s}.${i}`} {...rect} fill={color(s)} />);
        const lbl = chart.series[s].values[i]!;
        out.push(label(`l${s}.${i}`, horizontal ? Math.max(a0, a1) + 3 : rect.x + barW / 2, horizontal ? rect.y + barW / 2 + 4 : Math.min(a0, a1) - 3, lbl, horizontal ? "start" : "middle"));
      }
    }
  } else {
    const base: number[] = Array.from({ length: n }, () => 0);
    for (let s = 0; s < ns; s++) {
      const pts: ({ x: number; y: number } | null)[] = [];
      const lows: ({ x: number; y: number } | null)[] = [];
      for (let i = 0; i < n; i++) {
        const v = vals(s, i);
        if (v === null) {
          pts.push(null);
          lows.push(null);
          continue;
        }
        const nv = percent ? v / (totals[i].pos || 1) : v;
        const top = stacked ? base[i] + nv : nv;
        lows.push(point(s, i, stacked ? base[i] : 0));
        base[i] = top;
        pts.push(point(s, i, top));
      }
      const runs: { x: number; y: number }[][] = [];
      let cur: { x: number; y: number }[] = [];
      pts.forEach((p) => {
        if (p) cur.push(p);
        else if (cur.length) (runs.push(cur), (cur = []));
      });
      if (cur.length) runs.push(cur);
      if (chart.kind === "area") {
        const run = pts.filter((p): p is { x: number; y: number } => !!p);
        const low = lows.filter((p): p is { x: number; y: number } => !!p).reverse();
        if (run.length) out.push(<polygon key={`a${s}`} points={[...run, ...low].map((p) => `${p.x},${p.y}`).join(" ")} fill={color(s)} fillOpacity={0.55} stroke={color(s)} />);
      } else {
        runs.forEach((r, k) => out.push(<polyline key={`p${s}.${k}`} points={r.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={color(s)} strokeWidth={2} strokeLinejoin="round" />));
        pts.forEach((p, i) => p && out.push(<circle key={`d${s}.${i}`} cx={p.x} cy={p.y} r={3} fill={color(s)} />));
      }
      pts.forEach((p, i) => p && out.push(label(`l${s}.${i}`, p.x, p.y - 6, chart.series[s].values[i]!)));
    }
  }
  return <>{out}</>;
}

function pie(chart: SheetChart, a: Box, color: (i: number) => string) {
  const s = chart.series[0];
  const vs = (s?.values ?? []).map((v) => (v && v > 0 ? v : 0));
  const total = vs.reduce((x, y) => x + y, 0);
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const r = Math.max(10, Math.min(a.w, a.h) / 2 - 14);
  const inner = chart.kind === "doughnut" ? r * 0.55 : 0;
  if (!total) return null;
  let ang = -Math.PI / 2;
  const out: React.ReactNode[] = [];
  vs.forEach((v, i) => {
    if (!v) return;
    const da = (v / total) * Math.PI * 2;
    const [a0, a1] = [ang, ang + da];
    ang = a1;
    const p = (rr: number, t: number) => `${cx + rr * Math.cos(t)} ${cy + rr * Math.sin(t)}`;
    const big = da > Math.PI ? 1 : 0;
    const d = da >= Math.PI * 2 - 1e-6
      ? `M${cx} ${cy - r}A${r} ${r} 0 1 1 ${cx} ${cy + r}A${r} ${r} 0 1 1 ${cx} ${cy - r}${inner ? `M${cx} ${cy - inner}A${inner} ${inner} 0 1 0 ${cx} ${cy + inner}A${inner} ${inner} 0 1 0 ${cx} ${cy - inner}` : ""}Z`
      : inner
        ? `M${p(r, a0)}A${r} ${r} 0 ${big} 1 ${p(r, a1)}L${p(inner, a1)}A${inner} ${inner} 0 ${big} 0 ${p(inner, a0)}Z`
        : `M${cx} ${cy}L${p(r, a0)}A${r} ${r} 0 ${big} 1 ${p(r, a1)}Z`;
    out.push(<path key={i} d={d} fill={color(i)} stroke="var(--sht-bg, #fff)" strokeWidth={1.5} fillRule="evenodd" />);
    if (chart.labels) {
      const m = (a0 + a1) / 2;
      const lr = inner ? (r + inner) / 2 : r * 0.65;
      out.push(<text key={`l${i}`} x={cx + lr * Math.cos(m)} y={cy + lr * Math.sin(m) + 4} fontSize={FONT - 1} textAnchor="middle" fill="#fff">{fmt(s.values[i]!)}</text>);
    }
  });
  return <>{out}</>;
}

function scatter(chart: SheetChart, a: Box, color: (i: number) => string) {
  const xs = chart.series.flatMap((s, k) => s.values.map((_, i) => ((s.x ?? [])[i] ?? i + 1) + 0 * k));
  const ys = chart.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  if (!ys.length) return null;
  const tx = niceTicks(Math.min(...xs), Math.max(...xs));
  const ty = niceTicks(Math.min(0, ...ys), Math.max(...ys));
  const tickW = Math.max(...ty.map((t) => fmt(t).length)) * 6.5 + 8;
  const plot: Box = { x: a.x + tickW, y: a.y + 6, w: a.w - tickW - 10, h: a.h - 30 };
  const [x0, x1] = [tx[0], tx[tx.length - 1]];
  const [y0, y1] = [ty[0], ty[ty.length - 1]];
  const px = (v: number) => plot.x + ((v - x0) / (x1 - x0 || 1)) * plot.w;
  const py = (v: number) => plot.y + plot.h - ((v - y0) / (y1 - y0 || 1)) * plot.h;
  const out: React.ReactNode[] = [];
  ty.forEach((t, k) => out.push(
    <g key={`y${k}`}><line x1={plot.x} x2={plot.x + plot.w} y1={py(t)} y2={py(t)} stroke="var(--sep, #ddd)" /><text x={plot.x - 6} y={py(t) + 4} fontSize={FONT} textAnchor="end" fill="var(--l3)">{fmt(t)}</text></g>,
  ));
  tx.forEach((t, k) => out.push(<text key={`x${k}`} x={px(t)} y={plot.y + plot.h + 16} fontSize={FONT} textAnchor="middle" fill="var(--l3)">{fmt(t)}</text>));
  chart.series.forEach((s, k) =>
    s.values.forEach((v, i) => v !== null && out.push(<circle key={`${k}.${i}`} cx={px((s.x ?? [])[i] ?? i + 1)} cy={py(v)} r={4} fill={color(k)} fillOpacity={0.85} />)),
  );
  return <>{out}</>;
}

function radar(chart: SheetChart, a: Box, color: (i: number) => string) {
  const n = chart.categories.length || Math.max(...chart.series.map((s) => s.values.length), 3);
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const r = Math.max(10, Math.min(a.w, a.h) / 2 - 22);
  const all = chart.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = chart.max ?? niceTicks(0, Math.max(...all, 1)).at(-1)!;
  const at = (i: number, f: number) => ({ x: cx + r * f * Math.sin((i / n) * Math.PI * 2), y: cy - r * f * Math.cos((i / n) * Math.PI * 2) });
  const out: React.ReactNode[] = [];
  for (const f of [0.25, 0.5, 0.75, 1]) out.push(<polygon key={`g${f}`} points={Array.from({ length: n }, (_, i) => at(i, f)).map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="var(--sep, #ddd)" />);
  for (let i = 0; i < n; i++) {
    const p = at(i, 1.13);
    out.push(<text key={`c${i}`} x={p.x} y={p.y + 4} fontSize={FONT} textAnchor="middle" fill="var(--l2)">{clip(chart.categories[i] ?? "", 10)}</text>);
  }
  chart.series.forEach((s, k) =>
    out.push(<polygon key={`s${k}`} points={Array.from({ length: n }, (_, i) => at(i, Math.max(0, (s.values[i] ?? 0) / max))).map((p) => `${p.x},${p.y}`).join(" ")} fill={color(k)} fillOpacity={0.2} stroke={color(k)} strokeWidth={2} />),
  );
  return <>{out}</>;
}
