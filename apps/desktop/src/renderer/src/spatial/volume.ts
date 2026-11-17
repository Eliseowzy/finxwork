import { decompress } from "fzstd";

// A volume's original slices, read by the page itself (spatial-design §4.2, §13): the kernel
// writes the brick cache (crates/finx-spatial/src/brick.rs), the main process serves its two
// files by token at finxdoc://<token>/spatial/index.json and bricks.bin, and this reads the index,
// fetches one slab of bricks by a byte range, unpacks it and cuts axial slices out of it. Also the
// pure parts of the slice view: windows, patient sides, voxel ↔ millimetre. Free of React and three.
//
// A brick is its low bytes, then its high bytes, then zstd; bricks are in k, j, i order (i fastest),
// so the bricks of one slab (one brick row along k) are one range of the file.

export type Vec3 = [number, number, number];
export type Dims = [number, number, number];
export type BrickIndex = { brick: number; levels: { dims: Dims; bricks: [number, number][] }[] };

/** No data, as outside a CT's field of view (finx-spatial's `NODATA`). */
export const NODATA = -32768;

/** The voxels brick `b` of a level of size `dims` covers along each axis. */
export function brickExtent(dims: Dims, b: Dims, size: number): Dims {
  return [0, 1, 2].map((a) => Math.min(size, dims[a] - b[a] * size)) as Dims;
}

/** A brick's values from its packed bytes: low bytes first, then high bytes. */
export function unshuffle(bytes: Uint8Array, n: number): Int16Array {
  if (bytes.length !== n * 2) throw new Error(`a brick of ${n} voxels came as ${bytes.length} bytes`);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[n + i] << 8) | bytes[i];
  return out;
}

/** Axial slice `kk` (within the slab) of a slab's bricks (j, i order): `dims[0] * dims[1]` values, i fastest. */
export function sliceOfSlab(slab: Int16Array[], dims: Dims, bk: number, kk: number, size: number): Int16Array {
  const [w, h] = dims;
  const nbi = Math.ceil(w / size);
  const nbj = Math.ceil(h / size);
  const out = new Int16Array(w * h);
  for (let bj = 0; bj < nbj; bj++) {
    for (let bi = 0; bi < nbi; bi++) {
      const [bw, bh] = brickExtent(dims, [bi, bj, bk], size);
      const brick = slab[bj * nbi + bi];
      for (let j = 0; j < bh; j++) {
        const from = (kk * bh + j) * bw;
        out.set(brick.subarray(from, from + bw), (bj * size + j) * w + bi * size);
      }
    }
  }
  return out;
}

type Slab = { level: number; bk: number; bricks: Int16Array[] };

/** One volume's cache through its token, keeping the slabs it read last (about 100 MB of voxels). */
export class BrickSource {
  private index: Promise<BrickIndex> | null = null;
  private slabs: Slab[] = [];
  private loading = new Map<string, Promise<Slab>>();
  private readonly base: string;
  private readonly keep: number;

  /** `base`: `finxdoc://<token>`. */
  constructor(base: string, keep = 48 << 20) {
    this.base = base;
    this.keep = keep;
  }

  loadIndex(): Promise<BrickIndex> {
    this.index ??= fetch(`${this.base}/spatial/index.json`).then(async (r) => {
      if (!r.ok) throw new Error(`index.json: ${r.status}`);
      const j = await r.json();
      return { brick: j.brick, levels: j.levels };
    });
    return this.index;
  }

  /** Whether slice `k` of `level` can be cut without waiting. */
  has(level: number, k: number, size: number): boolean {
    return this.slabs.some((s) => s.level === level && s.bk === Math.floor(k / size));
  }

  async slab(level: number, bk: number): Promise<Slab> {
    const hit = this.slabs.find((s) => s.level === level && s.bk === bk);
    if (hit) {
      this.slabs = [...this.slabs.filter((s) => s !== hit), hit];
      return hit;
    }
    const key = `${level}/${bk}`;
    let p = this.loading.get(key);
    if (!p) {
      p = this.fetchSlab(level, bk).finally(() => this.loading.delete(key));
      this.loading.set(key, p);
    }
    return p;
  }

  private async fetchSlab(level: number, bk: number): Promise<Slab> {
    const index = await this.loadIndex();
    const lv = index.levels[level];
    const size = index.brick;
    const [nbi, nbj] = [Math.ceil(lv.dims[0] / size), Math.ceil(lv.dims[1] / size)];
    const first = bk * nbj * nbi;
    const entries = lv.bricks.slice(first, first + nbj * nbi);
    const start = Math.min(...entries.map(([o]) => o));
    const end = Math.max(...entries.map(([o, n]) => o + n));
    const r = await fetch(`${this.base}/spatial/bricks.bin`, { headers: { range: `bytes=${start}-${end - 1}` } });
    if (!r.ok) throw new Error(`bricks.bin: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    // A server that ignores Range sends the whole file.
    const at = r.status === 206 ? start : 0;
    const bricks = entries.map(([o, n], i) => {
      const [bw, bh, bd] = brickExtent(lv.dims, [i % nbi, Math.floor(i / nbi), bk], size);
      return unshuffle(decompress(bytes.subarray(o - at, o - at + n)), bw * bh * bd);
    });
    const slab = { level, bk, bricks };
    this.slabs.push(slab);
    const sizeOf = (s: Slab) => s.bricks.reduce((a, b) => a + b.length, 0);
    let held = this.slabs.reduce((sum, s) => sum + sizeOf(s), 0);
    while (held > this.keep && this.slabs.length > 1) held -= sizeOf(this.slabs.shift()!);
    return slab;
  }

  /** Axial slice `k` of `level`. */
  async slice(level: number, k: number): Promise<{ values: Int16Array; dims: Dims }> {
    const index = await this.loadIndex();
    const size = index.brick;
    const dims = index.levels[level].dims;
    const bk = Math.floor(k / size);
    const slab = await this.slab(level, bk);
    return { values: sliceOfSlab(slab.bricks, dims, bk, k % size, size), dims };
  }
}

// ── windows ──

/** A window preset: its name, width and level, in the volume's unit. `auto`: fitted to the values shown instead. */
export type Window = { name: string; width: number; level: number; auto?: true };

/** `profile.windows` (`[[name, width, level]]`), the well-formed ones; one fitted to the values shown when there are none. */
export function windowsOf(raw: readonly (readonly unknown[])[] | null | undefined, fallback = "默认"): Window[] {
  const out: Window[] = [];
  for (const w of raw ?? []) {
    const [name, width, level] = w;
    if (typeof name === "string" && typeof width === "number" && typeof level === "number" && width > 0) out.push({ name, width, level });
  }
  return out.length ? out : [{ name: fallback, width: 1, level: 0, auto: true }];
}

/** `w`, or for an `auto` window the one from the least to the greatest of `values` (no data left out). */
export function fit(values: Int16Array, w: Window): Window {
  if (!w.auto) return w;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === NODATA) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo < hi ? { ...w, width: hi - lo, level: (lo + hi) / 2 } : w;
}

/** A value's grey level (0–255) through a window. */
export function grey(v: number, w: Window): number {
  const g = ((v - (w.level - w.width / 2)) / w.width) * 255;
  return g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
}

/** Grey levels of `values` through a window, into RGBA; no data is black. */
export function paint(values: Int16Array, w: Window, out: Uint8ClampedArray) {
  const lo = w.level - w.width / 2;
  const scale = 255 / w.width;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const g = v === NODATA ? 0 : (v - lo) * scale;
    const o = i * 4;
    out[o] = out[o + 1] = out[o + 2] = g;
    out[o + 3] = 255;
  }
}

// ── patient sides (LPS: +x left, +y back, +z head) ──

export type Side = "R" | "L" | "A" | "P" | "I" | "S";
const SIDES = [["R", "L"], ["A", "P"], ["I", "S"]] as const;
const opposite: Record<Side, Side> = { R: "L", L: "R", A: "P", P: "A", I: "S", S: "I" };

/** The patient side a direction points to, by its largest component. */
export function sideOf(v: readonly number[]): Side {
  let axis = 0;
  for (let a = 1; a < 3; a++) if (Math.abs(v[a]) > Math.abs(v[axis])) axis = a;
  return SIDES[axis][v[axis] > 0 ? 1 : 0];
}

/** Which side each edge of an axial slice faces, shown with i to the right and j down. */
export function edges(direction: readonly (readonly number[])[]): { left: Side; right: Side; top: Side; bottom: Side } {
  const right = sideOf(direction[0]);
  const bottom = sideOf(direction[1]);
  return { left: opposite[right], right, top: opposite[bottom], bottom };
}

// ── voxels and millimetres ──

/** What the view needs of DocInfo.spatial.volume. */
export type Geometry = { dims: Dims; spacing: Vec3; origin: Vec3; direction: [Vec3, Vec3, Vec3] };

/** A voxel's centre (fractional i, j, k allowed) in patient mm. */
export function toMm(g: Geometry, ijk: readonly number[]): Vec3 {
  const p: Vec3 = [...g.origin];
  for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) p[c] += g.direction[a][c] * g.spacing[a] * ijk[a];
  return p;
}

/** Patient mm to fractional i, j, k (the direction is orthonormal). */
export function toVoxel(g: Geometry, p: readonly number[]): Vec3 {
  const d = [p[0] - g.origin[0], p[1] - g.origin[1], p[2] - g.origin[2]];
  return [0, 1, 2].map((a) => (d[0] * g.direction[a][0] + d[1] * g.direction[a][1] + d[2] * g.direction[a][2]) / g.spacing[a]) as Vec3;
}

/** The slice a point lies on, kept inside the volume. */
export const sliceAt = (g: Geometry, p: readonly number[]) => Math.max(0, Math.min(g.dims[2] - 1, Math.round(toVoxel(g, p)[2])));

/** The axial plane at slice k as the 3D view draws it: centre, in-plane axes (u along i, v against j so the picture is upright) and size, mm. */
export function slicePlane(g: Geometry, k: number): { origin: Vec3; u: Vec3; v: Vec3; size: [number, number] } {
  const [w, h] = g.dims;
  const origin = toMm(g, [(w - 1) / 2, (h - 1) / 2, k]);
  return { origin, u: [...g.direction[0]], v: g.direction[1].map((x) => -x) as Vec3, size: [w * g.spacing[0], h * g.spacing[1]] };
}

/** The slider value a drag lands on: a finding's slice when within `reach` of one. */
export function snap(k: number, ticks: readonly number[], reach: number): number {
  let best = k;
  let gap = reach + 1;
  for (const t of ticks) {
    const d = Math.abs(t - k);
    if (d <= reach && d < gap) (best = t), (gap = d);
  }
  return best;
}
