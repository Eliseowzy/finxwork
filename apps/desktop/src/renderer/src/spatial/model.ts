// What the spatial view shows, apart from three.js (spatial-design §4.2): the kernel's mesh
// format, findings and the current slice. Kept free of three so it can be tested in node and
// sent between the kernel and the page as plain data.

/**
 * A mesh as the kernel sends it (crates/finx-spatial/src/mesh.rs `encode`, spatial-design §13):
 * a 48-byte header — `FXMS`, version u16 (1), flags u16 (bit 0: normals follow the positions),
 * vertex count u32, index count u32, bounds min xyz then max xyz (f32 ×6), 8 reserved bytes —
 * then f32 xyz per vertex, the normals when flagged, then u32 indices; little-endian throughout.
 * The older, headerless form (u32 vertex count, u32 index count, positions, indices) still reads.
 */
export type MeshData = { positions: Float32Array; indices: Uint32Array; normals?: Float32Array; bounds?: [[number, number, number], [number, number, number]] };

const header = 8;
export const FXMS_HEADER = 48;

const floats = (view: DataView, at: number, n: number) => {
  // Copies: the buffer's offsets need not be aligned for typed views, and a view would pin the whole buffer.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(at + i * 4, true);
  return out;
};

const indicesAt = (view: DataView, at: number, count: number, vertices: number) => {
  if (count % 3 !== 0) throw new Error("mesh: index count is not a multiple of 3");
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const v = view.getUint32(at + i * 4, true);
    if (v >= vertices) throw new Error(`mesh: index ${v} past ${vertices} vertices`);
    out[i] = v;
  }
  return out;
};

const isFxms = (view: DataView) => view.byteLength >= 4 && view.getUint32(0, false) === 0x46584d53;

/** Reads the kernel's binary mesh; throws on a buffer that does not hold what its header says. */
export function decodeMesh(buffer: ArrayBuffer): MeshData {
  const view = new DataView(buffer);
  if (isFxms(view)) {
    if (buffer.byteLength < FXMS_HEADER) throw new Error("mesh: shorter than its header");
    const version = view.getUint16(4, true);
    if (version !== 1) throw new Error(`mesh: unknown version ${version}`);
    const withNormals = (view.getUint16(6, true) & 1) === 1;
    const vertices = view.getUint32(8, true);
    const count = view.getUint32(12, true);
    const need = FXMS_HEADER + vertices * 12 * (withNormals ? 2 : 1) + count * 4;
    if (buffer.byteLength !== need) throw new Error(`mesh: ${buffer.byteLength} bytes, header says ${need}`);
    const b = floats(view, 16, 6);
    const positions = floats(view, FXMS_HEADER, vertices * 3);
    const normals = withNormals ? floats(view, FXMS_HEADER + vertices * 12, vertices * 3) : undefined;
    const indices = indicesAt(view, FXMS_HEADER + vertices * 12 * (withNormals ? 2 : 1), count, vertices);
    return { positions, indices, ...(normals && { normals }), bounds: [[b[0], b[1], b[2]], [b[3], b[4], b[5]]] };
  }
  if (buffer.byteLength < header) throw new Error("mesh: shorter than its header");
  const vertices = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  const need = header + vertices * 12 + count * 4;
  if (buffer.byteLength < need) throw new Error(`mesh: ${buffer.byteLength} bytes, header says ${need}`);
  return { positions: floats(view, header, vertices * 3), indices: indicesAt(view, header + vertices * 12, count, vertices) };
}

/** The kernel's FXMS form, for tests and tools (mesh.rs `encode`). */
export function encodeFxms(positions: ArrayLike<number>, indices: ArrayLike<number>, normals?: ArrayLike<number>): ArrayBuffer {
  const vertices = Math.floor(positions.length / 3);
  const n = normals ? 2 : 1;
  const buffer = new ArrayBuffer(FXMS_HEADER + vertices * 12 * n + indices.length * 4);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46584d53, false);
  view.setUint16(4, 1, true);
  view.setUint16(6, normals ? 1 : 0, true);
  view.setUint32(8, vertices, true);
  view.setUint32(12, indices.length, true);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices * 3; i++) (lo[i % 3] = Math.min(lo[i % 3], positions[i])), (hi[i % 3] = Math.max(hi[i % 3], positions[i]));
  [...lo, ...hi].forEach((c, i) => view.setFloat32(16 + i * 4, vertices ? c : 0, true));
  for (let i = 0; i < vertices * 3; i++) view.setFloat32(FXMS_HEADER + i * 4, positions[i], true);
  if (normals) for (let i = 0; i < vertices * 3; i++) view.setFloat32(FXMS_HEADER + vertices * 12 + i * 4, normals[i], true);
  const at = FXMS_HEADER + vertices * 12 * n;
  for (let i = 0; i < indices.length; i++) view.setUint32(at + i * 4, indices[i], true);
  return buffer;
}

/** The older headerless form, for tests and tools that hand the view a mesh of their own. */
export function encodeMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): ArrayBuffer {
  const vertices = Math.floor(positions.length / 3);
  const buffer = new ArrayBuffer(header + vertices * 12 + indices.length * 4);
  const view = new DataView(buffer);
  view.setUint32(0, vertices, true);
  view.setUint32(4, indices.length, true);
  for (let i = 0; i < vertices * 3; i++) view.setFloat32(header + i * 4, positions[i], true);
  const at = header + vertices * 12;
  for (let i = 0; i < indices.length; i++) view.setUint32(at + i * 4, indices[i], true);
  return buffer;
}

/** Who found it. The view draws each its own way and never lets it change. */
export type FindingSource = "reference" | "ai" | "user";

/** Something found, at a place in millimetres. reference: from a report (a solid ring); ai: found by a script (a dashed ring); user: marked by the person (a pin). */
export type Finding = {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly source: FindingSource;
  readonly label?: string;
};

/** A mesh handed to the view, in the kernel's format. */
export type MeshInput = { name: string; data: ArrayBuffer; color?: string; opacity?: number; /** The kernel's mesh id, for structures. */ key?: string };

/** The current slice: a plane through `origin` facing `normal`, `size` wide and high (mm), showing a picture when given. */
export type SlicePlane = {
  origin: [number, number, number];
  normal: [number, number, number];
  /** The picture's right and up in the plane (a volume's i and −j); the normal follows from them when given. */
  axes?: [[number, number, number], [number, number, number]];
  size: [number, number];
  /** A URL (data: or finxdoc:) or a canvas/bitmap the page already has. */
  texture?: string | HTMLCanvasElement | ImageBitmap;
};

/** What a skill gives the view to say; the disclaimer shows whenever an ai finding does. */
export type SpatialProfile = { disclaimer?: string | null; orientation?: string | null };

/** A part as the list shows it. */
export type PartInfo = { id: number; name: string; visible: boolean; opacity: number; size: [number, number, number]; key?: string };

const sources = new Set<FindingSource>(["reference", "ai", "user"]);

/** Findings as the view keeps them: well-formed ones only, copied and frozen, so neither the page nor the view changes where one came from. */
export function sealFindings(list: readonly Finding[] | undefined): readonly Finding[] {
  if (!list) return [];
  return Object.freeze(
    list
      .filter((f) => sources.has(f.source) && f.position.length === 3 && f.position.every(Number.isFinite) && Number.isFinite(f.radius) && f.radius >= 0)
      .map((f) => Object.freeze({ id: f.id, source: f.source, radius: f.radius, position: Object.freeze([f.position[0], f.position[1], f.position[2]] as const), ...(f.label !== undefined && { label: f.label }) })),
  );
}

/** Whether the disclaimer must show. */
export const needsDisclaimer = (findings: readonly Finding[]) => findings.some((f) => f.source === "ai");

/** A length in millimetres as people read it. */
export function mm(n: number): string {
  const a = Math.abs(n);
  return a >= 100 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : n.toFixed(2);
}

/** A box's size, "20.0 × 12.5 × 8.00 mm". */
export const sizeLabel = (s: readonly [number, number, number]) => `${s.map(mm).join(" × ")} mm`;

/** What a part quoted into the conversation says: "三维 · file · part · size". */
export const partQuote = (prefix: string, file: string, part: string, size: readonly [number, number, number]) => [prefix, file, part, sizeLabel(size)].join(" · ");
