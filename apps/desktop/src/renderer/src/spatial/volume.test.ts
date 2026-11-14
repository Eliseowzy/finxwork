import { test } from "node:test";
import assert from "node:assert/strict";
import { NODATA, edges, fit, grey, paint, sideOf, sliceAt, sliceOfSlab, slicePlane, snap, toMm, toVoxel, unshuffle, windowsOf, type Geometry } from "./volume.ts";

test("profile windows: the well-formed ones in order, a default when none", () => {
  const w = windowsOf([["肺窗", 1500, -600], ["坏的", 0, 1], ["纵隔窗", 400, 40], [3, 2, 1]]);
  assert.deepEqual(w.map((x) => x.name), ["肺窗", "纵隔窗"]);
  assert.equal(windowsOf(undefined).length, 1);
});

test("with no profile windows the window fits the values shown, whatever their scale", () => {
  const [auto] = windowsOf(undefined);
  const w = fit(Int16Array.from([NODATA, 10, 200, 60]), auto);
  assert.deepEqual([w.width, w.level], [190, 105]);
  assert.equal(grey(10, w), 0);
  assert.equal(grey(200, w), 255);
  const lung = { name: "肺窗", width: 1500, level: -600 };
  assert.equal(fit(Int16Array.from([0, 255]), lung), lung);
});

test("a window maps its level to mid grey and clamps outside", () => {
  const lung = { name: "肺窗", width: 1500, level: -600 };
  assert.equal(grey(-600, lung), 128);
  assert.equal(grey(-1350, lung), 0);
  assert.equal(grey(150, lung), 255);
  assert.equal(grey(-2000, lung), 0);
  assert.equal(grey(3000, lung), 255);
  const out = new Uint8ClampedArray(8);
  paint(Int16Array.from([40, NODATA]), { name: "m", width: 400, level: 40 }, out);
  assert.ok(Math.abs(out[0] - 128) <= 1 && out[3] === 255);
  assert.deepEqual([...out.slice(4)], [0, 0, 0, 255]);
});

test("the edges of an axial slice face the patient's sides", () => {
  const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // Radiological convention: the patient's right on the left of the screen, front at the top.
  assert.deepEqual(edges(identity), { left: "R", right: "L", top: "A", bottom: "P" });
  // A volume stored mirrored and rotated a little.
  assert.deepEqual(edges([[-0.98, 0.1, 0], [0, -1, 0], [0, 0, 1]]), { left: "L", right: "R", top: "P", bottom: "A" });
  assert.equal(sideOf([0.1, 0.2, -0.9]), "I");
});

const g: Geometry = { dims: [256, 256, 200], spacing: [1.3, 1.3, 1.25], origin: [-165.75, -165.75, 0], direction: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };

test("voxels and millimetres go both ways", () => {
  assert.deepEqual(toMm(g, [0, 0, 0]), [-165.75, -165.75, 0]);
  const p = toMm(g, [10, 20, 30]);
  assert.deepEqual(toVoxel(g, p).map((x) => Math.round(x * 1e6) / 1e6), [10, 20, 30]);
  assert.equal(sliceAt(g, [0, 0, 95]), 76);
  assert.equal(sliceAt(g, [0, 0, -50]), 0);
  assert.equal(sliceAt(g, [0, 0, 1e4]), 199);
  const flipped: Geometry = { ...g, direction: [[1, 0, 0], [0, 1, 0], [0, 0, -1]], origin: [0, 0, 250] };
  assert.equal(sliceAt(flipped, [0, 0, 245]), 4);
});

test("the slice plane sits on the slice, centred, the picture upright", () => {
  const s = slicePlane(g, 100);
  assert.equal(s.origin[2], 125);
  assert.ok(Math.abs(s.origin[0] - (-165.75 + 127.5 * 1.3)) < 1e-9);
  assert.deepEqual(s.u, [1, 0, 0]);
  assert.deepEqual(s.v, [-0, -1, -0]);
  assert.deepEqual(s.size, [256 * 1.3, 256 * 1.3]);
});

test("a slider drag snaps to a finding's slice nearby", () => {
  assert.equal(snap(48, [50, 120], 3), 50);
  assert.equal(snap(45, [50, 120], 3), 45);
  assert.equal(snap(118, [50, 117, 120], 3), 117);
});

test("bricks unpack and a slab is cut into a slice", () => {
  const v = unshuffle(Uint8Array.from([0x34, 0xff, 0x12, 0xff]), 2);
  assert.deepEqual([...v], [0x1234, -1]);
  // A 3×2×1 level in bricks of 2: two bricks across i, one across j.
  const dims: [number, number, number] = [3, 2, 1];
  const slab = [Int16Array.from([1, 2, 4, 5]), Int16Array.from([3, 6])];
  assert.deepEqual([...sliceOfSlab(slab, dims, 0, 0, 2)], [1, 2, 3, 4, 5, 6]);
});
