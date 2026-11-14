import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMesh, encodeFxms, encodeMesh, FXMS_HEADER, needsDisclaimer, partQuote, sealFindings, type Finding } from "./model.ts";

test("a mesh comes back as it was sent", () => {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1.5];
  const indices = [0, 1, 2, 0, 2, 3];
  const m = decodeMesh(encodeMesh(positions, indices));
  assert.deepEqual([...m.positions], positions);
  assert.deepEqual([...m.indices], indices);
});

test("the header is little-endian u32s", () => {
  const b = new ArrayBuffer(8 + 36 + 12);
  const v = new DataView(b);
  v.setUint32(0, 3, true);
  v.setUint32(4, 3, true);
  v.setFloat32(8 + 4, 2.5, true);
  v.setUint32(44, 0, true); v.setUint32(48, 1, true); v.setUint32(52, 2, true);
  const m = decodeMesh(b);
  assert.equal(m.positions.length, 9);
  assert.equal(m.positions[1], 2.5);
  assert.deepEqual([...m.indices], [0, 1, 2]);
});

test("an empty mesh is fine", () => {
  const m = decodeMesh(encodeMesh([], []));
  assert.equal(m.positions.length, 0);
  assert.equal(m.indices.length, 0);
});

test("a short or broken buffer is refused", () => {
  assert.throws(() => decodeMesh(new ArrayBuffer(4)), /header/);
  const b = encodeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
  assert.throws(() => decodeMesh(b.slice(0, b.byteLength - 1)), /header says/);
  assert.throws(() => decodeMesh(encodeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 5])), /past 3 vertices/);
  assert.throws(() => decodeMesh(encodeMesh([0, 0, 0, 1, 0, 0], [0, 1])), /multiple of 3/);
});

test("findings are copied and frozen; a bad one is dropped", () => {
  const input = [
    { id: "a", position: [1, 2, 3], radius: 4, source: "ai" },
    { id: "b", position: [1, 2], radius: 4, source: "user" },
    { id: "c", position: [0, 0, 0], radius: 1, source: "made-up" },
  ] as unknown as Finding[];
  const out = sealFindings(input);
  assert.equal(out.length, 1);
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out[0]) && Object.isFrozen(out[0].position));
  assert.throws(() => { (out[0] as { source: string }).source = "user"; });
  (input[0] as { source: string }).source = "user";
  assert.equal(out[0].source, "ai");
  assert.ok(needsDisclaimer(out));
  assert.ok(!needsDisclaimer(sealFindings([{ id: "x", position: [0, 0, 0], radius: 1, source: "reference" }])));
});

test("a part's quote", () => {
  assert.equal(partQuote("三维", "a.glb", "Sphere", [20, 12.5, 8]), "三维 · a.glb · Sphere · 20.0 × 12.5 × 8.00 mm");
});

test("the kernel's FXMS mesh: header, bounds, normals", () => {
  const positions = [0, 0, 0, 2, 0, 0, 0, 3, -1];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  const m = decodeMesh(encodeFxms(positions, [0, 1, 2], normals));
  assert.deepEqual([...m.positions], positions);
  assert.deepEqual([...m.normals!], normals);
  assert.deepEqual([...m.indices], [0, 1, 2]);
  assert.deepEqual(m.bounds, [[0, 0, -1], [2, 3, 0]]);
  const plain = decodeMesh(encodeFxms(positions, [0, 1, 2]));
  assert.equal(plain.normals, undefined);
});

test("FXMS is read byte by byte as mesh.rs writes it", () => {
  // 'FXMS', v1, flags 0, 3 vertices, 3 indices, bounds, 8 zero bytes; then vertices and indices.
  const b = new ArrayBuffer(FXMS_HEADER + 36 + 12);
  const v = new DataView(b);
  [0x46, 0x58, 0x4d, 0x53].forEach((c, i) => v.setUint8(i, c));
  v.setUint16(4, 1, true);
  v.setUint32(8, 3, true);
  v.setUint32(12, 3, true);
  v.setFloat32(FXMS_HEADER + 12, 7.5, true);
  v.setUint32(FXMS_HEADER + 36 + 4, 1, true);
  v.setUint32(FXMS_HEADER + 36 + 8, 2, true);
  const m = decodeMesh(b);
  assert.equal(m.positions[3], 7.5);
  assert.deepEqual([...m.indices], [0, 1, 2]);
});

test("a broken FXMS mesh is refused", () => {
  const ok = encodeFxms([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.throws(() => decodeMesh(ok.slice(0, 20)), /header/);
  assert.throws(() => decodeMesh(ok.slice(0, ok.byteLength - 4)), /header says/);
  const v2 = ok.slice(0);
  new DataView(v2).setUint16(4, 2, true);
  assert.throws(() => decodeMesh(v2), /version/);
  assert.throws(() => decodeMesh(encodeFxms([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 9])), /past 3 vertices/);
});
