// FinxWork's mark in motion: the α of generator.html (variant "final") with its data
// points flowing along the stroke in writing order. They come in scattered at the first
// stroke, slow down and gather onto their strands as the ribbon condenses, and a few ride
// on through the solid ribbon as faint pulses to the tail. Framework-free: the desktop
// app, the brand page and export.sh's video all draw with it.
import G from "./finxwork-mark-geometry.js";

const ELECTRIC = ["#1B36D9", "#1F6BFF", "#2EB8FF"];
const ORIGIN = 187, VIEW = 650; // the square of the 1024 grid the app's PNGs and the SVG crop to
const N = G.thr.length; // strands across the ribbon
const M = G.rows.length / 5 - 1; // ribbon samples
const PERIOD = 18; // seconds for a data point to travel the whole stroke at speed 1
const INTRO = 1.8; // seconds to write the stroke on
const SWEEP = 2.4; // seconds for the light to run along the solid mark
const GLINT = 0.025; // share of data points that carry on through the ribbon as pulses
const TAU = Math.PI * 2;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// How much the stroke is still data at u (0 first stroke … 1 tail): the generator's "flow" shape.
const lifeAt = (u) => Math.max(0, 1 - u / 0.82) ** 1.15;
// Where strand k turns from dots into a line.
const breakAt = (k) => 0.82 * (1 - G.thr[k] ** (1 / 1.15));

// The ribbon at u: centre, unit normal and half-width, interpolated between samples.
const R0 = { x: 0, y: 0, nx: 0, ny: 0, w: 0 };
function at(u, o = R0) {
  const f = Math.min(M, Math.max(0, u * M)), i = Math.min(M - 1, Math.floor(f)), t = f - i, a = i * 5, b = a + 5, r = G.rows;
  o.x = r[a] + (r[b] - r[a]) * t; o.y = r[a + 1] + (r[b + 1] - r[a + 1]) * t;
  o.nx = r[a + 2] + (r[b + 2] - r[a + 2]) * t; o.ny = r[a + 3] + (r[b + 3] - r[a + 3]) * t;
  o.w = r[a + 4] + (r[b + 4] - r[a + 4]) * t;
  return o;
}

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// The data points, built once and the same in every view. Each strand carries them as
// evenly as the still mark spaces its dots, which spreads them apart where the stroke is
// most scattered; moving at a constant pace in that spacing makes them travel fast where
// they are scattered and slow down as they gather, with the mark's density everywhere.
let P;
function points() {
  if (P) return P;
  const K = 2048, cum = new Float64Array(K + 1);
  for (let i = 1; i <= K; i++) cum[i] = cum[i - 1] + 1200 / 9 / (1 + 1.3 * lifeAt((i - 0.5) / K)) / K;
  const total = cum[K], uOf = new Float32Array(K + 1);
  for (let i = 0, j = 0; i <= K; i++) {
    const c = (i / K) * total;
    while (j < K - 1 && cum[j + 1] < c) j++;
    uOf[i] = (j + Math.min(1, (c - cum[j]) / (cum[j + 1] - cum[j]))) / K;
  }
  const per = Math.round(total), n = N * per, R = rng(31);
  P = { n, uOf, K, k: new Uint8Array(n), at: new Float32Array(n), jit: new Float32Array(n), out: new Float32Array(n), size: new Float32Array(n), kind: new Uint8Array(n) };
  for (let k = 0, i = 0; k < N; k++) {
    const off = R();
    for (let q = 0; q < per; q++, i++) {
      P.k[i] = k; P.at[i] = (q + off) / per;
      P.jit[i] = R() - 0.5; P.out[i] = R(); P.size[i] = R();
      // 0: a dot that settles into its strand, 1: one that carries on as a pulse, 2: none (the mark keeps 9 in 10).
      const r = R();
      P.kind[i] = r > 0.9 ? 2 : r < GLINT ? 1 : 0;
    }
  }
  return P;
}

// Draw calls grouped by alpha, so a frame is a few dozen fills, not thousands.
const LEVELS = 16;
const buckets = Array.from({ length: LEVELS }, () => ({ n: 0, a: new Float32Array(0) }));
function push(alpha, x0, y0, x1, y1) {
  const b = buckets[Math.min(LEVELS - 1, Math.round(alpha * (LEVELS - 1)))];
  if (b.a.length < (b.n + 1) * 4) { const a = new Float32Array(Math.max(1024, b.a.length * 2)); a.set(b.a); b.a = a; }
  b.a.set([x0, y0, x1, y1], b.n * 4); b.n++;
}

function gradient(ctx) {
  const g = ctx.createLinearGradient(G.box.x0, G.box.y1, G.box.x1, G.box.y0);
  ELECTRIC.forEach((c, i) => g.addColorStop(i / (ELECTRIC.length - 1), c));
  return g;
}

// The ribbon's quads from u0 to u1 at the generator's 1200 steps (coarser steps show their
// seams through a faint fill), each at alphaOf(u) of the current alpha.
const Q = 1200;
function quads(ctx, u0, u1, alphaOf) {
  const base = ctx.globalAlpha, a = { ...R0 }, b = { ...R0 };
  for (let i = Math.floor(u0 * Q); i < Math.min(Q, u1 * Q); i++) {
    const al = alphaOf(i / Q);
    if (al <= 0.003) continue;
    at(i / Q, a); at((i + 1) / Q, b);
    ctx.globalAlpha = base * al;
    ctx.beginPath();
    ctx.moveTo(a.x + a.nx * a.w, a.y + a.ny * a.w); ctx.lineTo(b.x + b.nx * b.w, b.y + b.ny * b.w);
    ctx.lineTo(b.x - b.nx * b.w, b.y - b.ny * b.w); ctx.lineTo(a.x - a.nx * a.w, a.y - a.ny * a.w); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.globalAlpha = base;
}

// What does not move: the faint body under the strands, and each strand's line from its
// break point to the tail. `end` < 1 draws only the stroke written so far.
function drawBase(ctx, theme, end = 1) {
  const g = gradient(ctx), dark = theme === "dark", A = dark ? 0.42 : 0.66, o = { ...R0 };
  ctx.fillStyle = g; ctx.strokeStyle = g; ctx.lineWidth = 0.8;
  ctx.globalAlpha = dark ? 0.22 : 0.26;
  quads(ctx, 0, end, (u) => 1 - lifeAt(u));
  ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
  ctx.lineJoin = "round";
  for (let k = 0; k < N; k++) {
    const s = (k / (N - 1)) * 2 - 1, edge = k === 0 || k === N - 1, u0 = breakAt(k);
    if (u0 >= end) continue;
    ctx.globalAlpha = edge ? A + 0.12 : A; ctx.lineWidth = edge ? 1.25 : 1.15;
    ctx.beginPath();
    at(u0, o); ctx.moveTo(o.x + o.nx * o.w * s, o.y + o.ny * o.w * s);
    for (let i = Math.ceil(u0 * M); i <= Math.min(M, end * M); i++) { at(i / M, o); ctx.lineTo(o.x + o.nx * o.w * s, o.y + o.ny * o.w * s); }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
}

// The data points at time t (seconds of travel), as far as the stroke is written (`end`).
function drawPoints(ctx, theme, t, end) {
  const p = points(), dark = theme === "dark", A = dark ? 0.42 : 0.66, shift = t / PERIOD, o = { ...R0 }, q = { ...R0 };
  for (const b of buckets) b.n = 0;
  const pulses = [];
  for (let i = 0; i < p.n; i++) {
    if (p.kind[i] === 2) continue;
    let f = (p.at[i] + shift) % 1; if (f < 0) f += 1;
    const x = f * p.K, j = Math.floor(x), u = p.uOf[j] + (p.uOf[Math.min(p.K, j + 1)] - p.uOf[j]) * (x - j);
    if (u > end) continue;
    const k = p.k[i], thr = G.thr[k], life = lifeAt(u), s = (k / (N - 1)) * 2 - 1;
    const shown = smooth(0, 0.012, u) * (1 - smooth(end - 0.05, end, u));
    if (life >= thr) {
      // A dot: scattered off its strand and outward as much as the stroke is still data,
      // fading as it reaches its strand's break point and joins the line.
      at(u, o);
      const jit = p.jit[i] * 2 * life * 16, out = 1 + life * 0.35 * p.out[i], off = s * out + jit / (o.w || 1);
      const a = Math.min(1, A * (1 - 0.35 * life) + 0.25) * shown * smooth(thr, thr + 0.05, life) * (1 - smooth(0.9, 0.98, Math.abs(off)));
      if (a < 0.02) continue;
      const cx = o.x + o.nx * o.w * s * out + o.nx * jit, cy = o.y + o.ny * o.w * s * out + o.ny * jit;
      push(a, cx, cy, 0.9 + 1.7 * p.size[i] * (1 - 0.5 * life), 0);
    } else if (p.kind[i] === 1) {
      // A pulse: a short bright streak riding its strand through the ribbon to the tail.
      const a = smooth(thr, thr - 0.1, life) * (1 - smooth(0.88, 0.98, u)) * shown;
      if (a < 0.02) continue;
      at(u, o); at(Math.max(0, u - 0.012), q);
      pulses.push(a, q.x + q.nx * q.w * s, q.y + q.ny * q.w * s, o.x + o.nx * o.w * s, o.y + o.ny * o.w * s);
    }
  }
  ctx.globalCompositeOperation = dark ? "lighter" : "source-over";
  ctx.fillStyle = gradient(ctx);
  buckets.forEach((b, l) => {
    if (!b.n) return;
    ctx.globalAlpha = l / (LEVELS - 1);
    ctx.beginPath();
    for (let i = 0; i < b.n * 4; i += 4) { ctx.moveTo(b.a[i] + b.a[i + 2], b.a[i + 1]); ctx.arc(b.a[i], b.a[i + 1], b.a[i + 2], 0, TAU); }
    ctx.fill();
  });
  // Light running through the ribbon: a pale blue added on dark, white laid over on light.
  ctx.strokeStyle = dark ? "#7FD3FF" : "#FFFFFF"; ctx.lineCap = "round"; ctx.lineWidth = 1.3;
  for (let i = 0; i < pulses.length; i += 5) {
    ctx.globalAlpha = pulses[i] * (dark ? 0.35 : 0.55);
    ctx.beginPath(); ctx.moveTo(pulses[i + 1], pulses[i + 2]); ctx.lineTo(pulses[i + 3], pulses[i + 4]); ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
}

// The solid mark (small sizes) with a soft light running along it in writing order.
function drawSolid(ctx, theme, t, end) {
  const g = gradient(ctx);
  ctx.fillStyle = g; ctx.strokeStyle = g; ctx.lineWidth = 0.8;
  quads(ctx, 0, end, (u) => 1 - smooth(end - 0.04, end, u));
  const c = ((t / SWEEP) % 1) * 1.5 - 0.25;
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = ctx.strokeStyle = theme === "dark" ? "#C8EEFF" : "#FFFFFF";
  ctx.globalAlpha = 0.5;
  quads(ctx, Math.max(0, c - 0.25), Math.min(end, c + 0.25), (u) => Math.exp(-(((u - c) / 0.09) ** 2)));
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
}

// How much of the stroke is written t seconds into the intro (1 and up: all of it).
const written = (t) => 1.06 * (1 - (1 - Math.min(1, t / INTRO)) ** 3);

// The rewrite loop (something in progress): write the stroke on in 1.3 s, hold 0.9 s while
// the light runs along it once, fade out in 0.5 s, rest 0.3 s, and write again.
const REWRITE = 3;
function rewriteAt(t) {
  const p = t % REWRITE;
  return {
    reveal: Math.min(1, 1.04 * (1 - (1 - Math.min(1, p / 1.3)) ** 3)),
    alpha: p < 2.2 ? 1 : Math.max(0, 1 - (p - 2.2) / 0.5),
    // The light's own clock, held at the end of its one run so it does not start again in the fade.
    sweep: Math.min(0.999, Math.max(0, p - 1.1) / 1.1) * SWEEP,
  };
}

/**
 * One frame of the mark into ctx, filling size × size device pixels from the current origin.
 * t: seconds of motion; reveal: how much of the stroke is written (1: all).
 * For exports; on screen use animateMark, which keeps a cache of what does not move.
 */
export function drawMarkFrame(ctx, size, t, { theme = "dark", look = "strands", reveal = 1 } = {}) {
  ctx.save(); ctx.scale(size / VIEW, size / VIEW); ctx.translate(-ORIGIN, -ORIGIN);
  if (look === "solid") drawSolid(ctx, theme, t, reveal);
  else { drawBase(ctx, theme, reveal); drawPoints(ctx, theme, t, reveal); }
  ctx.restore();
}

/**
 * Draws the mark into a canvas sized by CSS and keeps it moving until stop().
 * theme: "dark" | "light" | "auto" (the system's appearance; the default).
 * look: "strands", the data-point mark, for 96 px and up | "solid", for smaller sizes.
 * speed: 1 takes a data point along the whole stroke in 18 s (and the solid look's light in 2.4 s).
 * intro: first write the stroke on in writing order.
 * rewrite: the solid mark written on, held and faded over and over, for something in progress.
 * With reduced motion it draws one still frame: the mark as it stands.
 */
export function animateMark(canvas, { theme = "auto", look = "strands", speed = 1, intro = false, rewrite = false } = {}) {
  const ctx = canvas.getContext("2d"), scheme = matchMedia("(prefers-color-scheme: dark)");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start = performance.now();
  let cache = null, key = "", raf = 0;
  const paint = (now) => {
    const px = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), th = theme === "auto" ? (scheme.matches ? "dark" : "light") : theme;
    if (canvas.width !== px || canvas.height !== px) canvas.width = canvas.height = px;
    const t = still ? 0 : (now - start) / 1000, reveal = still || !intro ? 1 : written(t);
    ctx.clearRect(0, 0, px, px);
    if (rewrite && !still) {
      const r = rewriteAt(t * speed);
      ctx.globalAlpha = r.alpha;
      if (r.alpha > 0) drawMarkFrame(ctx, px, r.sweep, { theme: th, look: "solid", reveal: r.reveal });
      ctx.globalAlpha = 1;
    } else if (rewrite || look === "solid" || reveal < 1) drawMarkFrame(ctx, px, t * speed, { theme: th, look: rewrite ? "solid" : look, reveal: Math.min(1, reveal) });
    else {
      if (key !== px + th) {
        cache = Object.assign(document.createElement("canvas"), { width: px, height: px });
        const c = cache.getContext("2d");
        c.scale(px / VIEW, px / VIEW); c.translate(-ORIGIN, -ORIGIN); drawBase(c, th);
        key = px + th;
      }
      ctx.drawImage(cache, 0, 0);
      ctx.save(); ctx.scale(px / VIEW, px / VIEW); ctx.translate(-ORIGIN, -ORIGIN); drawPoints(ctx, th, t * speed, 1); ctx.restore();
    }
    if (!still) raf = requestAnimationFrame(paint);
  };
  // A still frame only needs drawing again when its size or the appearance changes.
  const redraw = () => still && paint(performance.now());
  const ro = new ResizeObserver(redraw);
  ro.observe(canvas); scheme.addEventListener("change", redraw);
  raf = requestAnimationFrame(paint);
  return { stop() { cancelAnimationFrame(raf); ro.disconnect(); scheme.removeEventListener("change", redraw); } };
}
