//! Generic algorithms on a volume and its labels (spatial-design §4.1): threshold, connected
//! components, morphology in mm, hole filling, region growing and statistics. Whole-volume and in
//! memory for now; correct first. Nothing here knows what the values mean.

use crate::volume::{NODATA, Volume, VolumeInfo};
use std::collections::VecDeque;

/// Where voxels sit in patient space: a volume's geometry without its values.
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub dims: [u32; 3],
    /// mm along i, j, k.
    pub spacing: [f64; 3],
    /// The first voxel's centre, LPS mm.
    pub origin: [f64; 3],
    /// The directions of i, j and k in LPS.
    pub direction: [[f64; 3]; 3],
}

impl Grid {
    pub fn of(info: &VolumeInfo) -> Self {
        Self {
            dims: info.dims,
            spacing: info.spacing,
            origin: info.origin,
            direction: info.direction,
        }
    }

    pub fn len(&self) -> usize {
        self.dims.iter().map(|d| *d as usize).product()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn voxel_mm3(&self) -> f64 {
        self.spacing.iter().product()
    }

    #[inline]
    pub fn index(&self, i: u32, j: u32, k: u32) -> usize {
        (k as usize * self.dims[1] as usize + j as usize) * self.dims[0] as usize + i as usize
    }

    #[inline]
    pub fn ijk(&self, n: usize) -> [u32; 3] {
        let (w, h) = (self.dims[0] as usize, self.dims[1] as usize);
        [(n % w) as u32, ((n / w) % h) as u32, (n / (w * h)) as u32]
    }

    /// LPS mm of (fractional) voxel indices.
    pub fn to_patient(&self, ijk: [f64; 3]) -> [f64; 3] {
        [0, 1, 2].map(|c| {
            self.origin[c]
                + (0..3)
                    .map(|a| self.direction[a][c] * self.spacing[a] * ijk[a])
                    .sum::<f64>()
        })
    }

    /// Fractional voxel indices of an LPS position (the directions are orthonormal).
    pub fn to_index(&self, p: [f64; 3]) -> [f64; 3] {
        let d = [0, 1, 2].map(|c| p[c] - self.origin[c]);
        [0, 1, 2].map(|a| (0..3).map(|c| d[c] * self.direction[a][c]).sum::<f64>() / self.spacing[a])
    }

    /// The six face neighbours of voxel `n`.
    #[inline]
    fn neighbours(&self, n: usize, out: &mut [usize; 6]) -> usize {
        let [i, j, k] = self.ijk(n);
        let [w, h, d] = self.dims;
        let (sx, sy) = (1usize, w as usize);
        let sz = (w * h) as usize;
        let mut c = 0;
        if i > 0 {
            out[c] = n - sx;
            c += 1;
        }
        if i + 1 < w {
            out[c] = n + sx;
            c += 1;
        }
        if j > 0 {
            out[c] = n - sy;
            c += 1;
        }
        if j + 1 < h {
            out[c] = n + sy;
            c += 1;
        }
        if k > 0 {
            out[c] = n - sz;
            c += 1;
        }
        if k + 1 < d {
            out[c] = n + sz;
            c += 1;
        }
        c
    }
}

/// A set of voxels of a grid: one label of a label volume.
#[derive(Clone, Debug, PartialEq)]
pub struct Mask {
    pub grid: Grid,
    pub data: Vec<bool>,
}

impl Mask {
    pub fn empty(grid: Grid) -> Self {
        let n = grid.len();
        Self {
            grid,
            data: vec![false; n],
        }
    }

    pub fn full(grid: Grid) -> Self {
        let n = grid.len();
        Self {
            grid,
            data: vec![true; n],
        }
    }

    pub fn count(&self) -> usize {
        self.data.iter().filter(|b| **b).count()
    }

    pub fn volume_mm3(&self) -> f64 {
        self.count() as f64 * self.grid.voxel_mm3()
    }

    pub fn and(&mut self, other: &Mask) {
        for (a, b) in self.data.iter_mut().zip(&other.data) {
            *a &= *b;
        }
    }

    pub fn and_not(&mut self, other: &Mask) {
        for (a, b) in self.data.iter_mut().zip(&other.data) {
            *a &= !*b;
        }
    }

    pub fn or(&mut self, other: &Mask) {
        for (a, b) in self.data.iter_mut().zip(&other.data) {
            *a |= *b;
        }
    }

    pub fn invert(&mut self) {
        for a in &mut self.data {
            *a = !*a;
        }
    }

    /// The smallest box holding every voxel, `[min, max]` inclusive; `None` when empty.
    pub fn bbox(&self) -> Option<[[u32; 3]; 2]> {
        let mut lo = [u32::MAX; 3];
        let mut hi = [0u32; 3];
        let mut any = false;
        for (n, _) in self.data.iter().enumerate().filter(|(_, b)| **b) {
            let p = self.grid.ijk(n);
            for a in 0..3 {
                lo[a] = lo[a].min(p[a]);
                hi[a] = hi[a].max(p[a]);
            }
            any = true;
        }
        any.then_some([lo, hi])
    }
}

/// Voxels whose value is within `[lo, hi]` (either end open). Voxels with no data never are.
pub fn threshold(vol: &Volume, lo: Option<f64>, hi: Option<f64>) -> Mask {
    let lo = lo.unwrap_or(f64::NEG_INFINITY);
    let hi = hi.unwrap_or(f64::INFINITY);
    let nodata = vol.info.has_nodata;
    Mask {
        grid: Grid::of(&vol.info),
        data: vol
            .values
            .iter()
            .map(|v| !(nodata && *v == NODATA) && (*v as f64) >= lo && (*v as f64) <= hi)
            .collect(),
    }
}

/// Every voxel with data.
pub fn has_data(vol: &Volume) -> Mask {
    threshold(vol, None, None)
}

/// 6-connected components: a label per voxel (0 outside the mask, then 1, 2, … in scan order) and
/// each label's size in voxels (`sizes[0]` is unused).
pub fn components(mask: &Mask) -> (Vec<u32>, Vec<u64>) {
    let g = &mask.grid;
    let mut labels = vec![0u32; mask.data.len()];
    let mut sizes = vec![0u64];
    let mut stack = Vec::new();
    let mut nb = [0usize; 6];
    for start in 0..mask.data.len() {
        if !mask.data[start] || labels[start] != 0 {
            continue;
        }
        let label = sizes.len() as u32;
        let mut size = 0u64;
        labels[start] = label;
        stack.push(start);
        while let Some(n) = stack.pop() {
            size += 1;
            let c = g.neighbours(n, &mut nb);
            for &m in &nb[..c] {
                if mask.data[m] && labels[m] == 0 {
                    labels[m] = label;
                    stack.push(m);
                }
            }
        }
        sizes.push(size);
    }
    (labels, sizes)
}

fn keep_labels(mask: &Mask, labels: &[u32], keep: &[bool]) -> Mask {
    Mask {
        grid: mask.grid.clone(),
        data: labels.iter().map(|l| keep[*l as usize]).collect(),
    }
}

/// The `n` largest components.
pub fn keep_largest(mask: &Mask, n: usize) -> Mask {
    let (labels, sizes) = components(mask);
    let mut order: Vec<usize> = (1..sizes.len()).collect();
    order.sort_by(|a, b| sizes[*b].cmp(&sizes[*a]).then(a.cmp(b)));
    let mut keep = vec![false; sizes.len()];
    for l in order.into_iter().take(n) {
        keep[l] = true;
    }
    keep_labels(mask, &labels, &keep)
}

/// Components of at least `mm3`.
pub fn drop_smaller_than_mm3(mask: &Mask, mm3: f64) -> Mask {
    let (labels, sizes) = components(mask);
    let v = mask.grid.voxel_mm3();
    let mut keep: Vec<bool> = sizes.iter().map(|s| *s as f64 * v >= mm3).collect();
    keep[0] = false;
    keep_labels(mask, &labels, &keep)
}

/// Components that touch no face of the volume.
pub fn drop_touching_border(mask: &Mask) -> Mask {
    let (labels, sizes) = components(mask);
    let mut keep = vec![true; sizes.len()];
    keep[0] = false;
    let [w, h, d] = mask.grid.dims;
    for (n, l) in labels.iter().enumerate() {
        if *l == 0 {
            continue;
        }
        let [i, j, k] = mask.grid.ijk(n);
        if i == 0 || j == 0 || k == 0 || i + 1 == w || j + 1 == h || k + 1 == d {
            keep[*l as usize] = false;
        }
    }
    keep_labels(mask, &labels, &keep)
}

/// The component holding voxel `seed`; empty when the seed is outside the mask.
pub fn connected_to(mask: &Mask, seed: [u32; 3]) -> Mask {
    let g = &mask.grid;
    let mut out = Mask::empty(g.clone());
    if (0..3).any(|a| seed[a] >= g.dims[a]) {
        return out;
    }
    let s = g.index(seed[0], seed[1], seed[2]);
    if !mask.data[s] {
        return out;
    }
    let mut stack = vec![s];
    out.data[s] = true;
    let mut nb = [0usize; 6];
    while let Some(n) = stack.pop() {
        let c = g.neighbours(n, &mut nb);
        for &m in &nb[..c] {
            if mask.data[m] && !out.data[m] {
                out.data[m] = true;
                stack.push(m);
            }
        }
    }
    out
}

/// The voxels outside the mask that cannot reach the volume's faces through other voxels outside
/// it — cavities — plus, slice by slice along k, the holes enclosed within each slice. The second
/// part fills tubes that cross the volume's end (an open pipe is a hole in every slice), which a
/// 3D fill alone leaves open.
pub fn fill_holes(mask: &Mask) -> Mask {
    let g = &mask.grid;
    let [w, h, d] = g.dims;
    let mut out = mask.clone();
    // 3D: flood the outside from the faces.
    let mut outside = vec![false; mask.data.len()];
    let mut stack = Vec::new();
    for (n, b) in mask.data.iter().enumerate() {
        if *b {
            continue;
        }
        let [i, j, k] = g.ijk(n);
        if i == 0 || j == 0 || k == 0 || i + 1 == w || j + 1 == h || k + 1 == d {
            outside[n] = true;
            stack.push(n);
        }
    }
    let mut nb = [0usize; 6];
    while let Some(n) = stack.pop() {
        let c = g.neighbours(n, &mut nb);
        for &m in &nb[..c] {
            if !mask.data[m] && !outside[m] {
                outside[m] = true;
                stack.push(m);
            }
        }
    }
    for (o, out_) in out.data.iter_mut().zip(&outside) {
        if !*out_ {
            *o = true;
        }
    }
    // 2D, each slice.
    let plane = (w * h) as usize;
    let mut reach = vec![false; plane];
    for k in 0..d as usize {
        let s = &mask.data[k * plane..(k + 1) * plane];
        reach.iter_mut().for_each(|r| *r = false);
        stack.clear();
        for j in 0..h {
            for i in 0..w {
                let n = (j * w + i) as usize;
                if !s[n] && (i == 0 || j == 0 || i + 1 == w || j + 1 == h) {
                    reach[n] = true;
                    stack.push(n);
                }
            }
        }
        while let Some(n) = stack.pop() {
            let (i, j) = ((n % w as usize) as u32, (n / w as usize) as u32);
            let visit = |m: usize, reach: &mut [bool], stack: &mut Vec<usize>| {
                if !s[m] && !reach[m] {
                    reach[m] = true;
                    stack.push(m);
                }
            };
            if i > 0 {
                visit(n - 1, &mut reach, &mut stack);
            }
            if i + 1 < w {
                visit(n + 1, &mut reach, &mut stack);
            }
            if j > 0 {
                visit(n - w as usize, &mut reach, &mut stack);
            }
            if j + 1 < h {
                visit(n + w as usize, &mut reach, &mut stack);
            }
        }
        for (n, r) in reach.iter().enumerate() {
            if !*r {
                out.data[k * plane + n] = true;
            }
        }
    }
    out
}

/// 1D squared distance transform (Felzenszwalb–Huttenlocher) of `f` sampled every `step` mm.
fn edt_1d(f: &[f32], step: f32, out: &mut [f32], v: &mut [usize], z: &mut [f32]) {
    let n = f.len();
    let x = |q: usize| q as f32 * step;
    let mut k = 0usize;
    let first = (0..n).find(|q| f[*q].is_finite());
    let Some(first) = first else {
        out.iter_mut().for_each(|o| *o = f32::INFINITY);
        return;
    };
    v[0] = first;
    z[0] = f32::NEG_INFINITY;
    z[1] = f32::INFINITY;
    for q in first + 1..n {
        if !f[q].is_finite() {
            continue;
        }
        loop {
            let p = v[k];
            let s = ((f[q] + x(q) * x(q)) - (f[p] + x(p) * x(p))) / (2.0 * (x(q) - x(p)));
            if s <= z[k] && k > 0 {
                k -= 1;
                continue;
            }
            if s <= z[k] {
                // k == 0 and the new parabola hides the first everywhere.
                v[0] = q;
                z[0] = f32::NEG_INFINITY;
                z[1] = f32::INFINITY;
                break;
            }
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = f32::INFINITY;
            break;
        }
    }
    let mut k = 0usize;
    for (q, o) in out.iter_mut().enumerate() {
        while z[k + 1] < x(q) {
            k += 1;
        }
        let p = v[k];
        *o = (x(q) - x(p)) * (x(q) - x(p)) + f[p];
    }
}

/// Squared distance in mm from each voxel of the box `[lo, hi)` to the nearest voxel of the mask
/// in that box, exact (separable EDT), box-local i fastest.
fn distance_sq(mask: &Mask, lo: [u32; 3], hi: [u32; 3]) -> Vec<f32> {
    let g = &mask.grid;
    let size = [0, 1, 2].map(|a| (hi[a] - lo[a]) as usize);
    let mut d: Vec<f32> = Vec::with_capacity(size[0] * size[1] * size[2]);
    for k in lo[2]..hi[2] {
        for j in lo[1]..hi[1] {
            for i in lo[0]..hi[0] {
                d.push(if mask.data[g.index(i, j, k)] { 0.0 } else { f32::INFINITY });
            }
        }
    }
    let longest = *size.iter().max().unwrap_or(&1);
    let mut f = vec![0f32; longest];
    let mut out = vec![0f32; longest];
    let mut v = vec![0usize; longest];
    let mut z = vec![0f32; longest + 1];
    let stride = [1, size[0], size[0] * size[1]];
    for axis in 0..3 {
        let n = size[axis];
        let (a, b) = match axis {
            0 => (1, 2),
            1 => (0, 2),
            _ => (0, 1),
        };
        for y in 0..size[b] {
            for x in 0..size[a] {
                let base = x * stride[a] + y * stride[b];
                for q in 0..n {
                    f[q] = d[base + q * stride[axis]];
                }
                edt_1d(&f[..n], g.spacing[axis] as f32, &mut out[..n], &mut v, &mut z);
                for q in 0..n {
                    d[base + q * stride[axis]] = out[q];
                }
            }
        }
    }
    d
}

/// Every voxel within `mm` of the mask (a ball in mm, so anisotropic voxels are handled).
pub fn dilate_mm(mask: &Mask, mm: f64) -> Mask {
    let g = &mask.grid;
    let Some([lo, hi]) = mask.bbox() else {
        return mask.clone();
    };
    let r = [0, 1, 2].map(|a| (mm / g.spacing[a]).ceil() as u32);
    let lo = [0, 1, 2].map(|a| lo[a].saturating_sub(r[a]));
    let hi = [0, 1, 2].map(|a| (hi[a] + r[a] + 1).min(g.dims[a]));
    let d = distance_sq(mask, lo, hi);
    let limit = (mm * mm) as f32 * (1.0 + 1e-5) + 1e-6;
    let mut out = mask.clone();
    let mut n = 0;
    for k in lo[2]..hi[2] {
        for j in lo[1]..hi[1] {
            for i in lo[0]..hi[0] {
                if d[n] <= limit {
                    out.data[g.index(i, j, k)] = true;
                }
                n += 1;
            }
        }
    }
    out
}

/// The voxels further than `mm` from anything outside the mask. Beyond the volume's faces counts
/// as inside: a structure cut by the field of view is not worn away at the cut.
pub fn erode_mm(mask: &Mask, mm: f64) -> Mask {
    let mut inv = mask.clone();
    inv.invert();
    let mut out = dilate_mm(&inv, mm);
    out.invert();
    out
}

/// Voxels connected (6-neighbours) to `seed` with values in `[lo, hi]`, and inside `within` when
/// given. Grows breadth first and stops once it has `max_mm3` (the nearest voxels are kept), so a
/// leak cannot take the volume. `None` when the seed's own value is out of range.
pub fn region_grow(
    vol: &Volume,
    seed: [u32; 3],
    lo: f64,
    hi: f64,
    max_mm3: Option<f64>,
    within: Option<&Mask>,
) -> Option<(Mask, bool)> {
    let g = Grid::of(&vol.info);
    if (0..3).any(|a| seed[a] >= g.dims[a]) {
        return None;
    }
    let ok = |n: usize| {
        let v = vol.values[n];
        !(vol.info.has_nodata && v == NODATA)
            && (v as f64) >= lo
            && (v as f64) <= hi
            && within.is_none_or(|w| w.data[n])
    };
    let s = g.index(seed[0], seed[1], seed[2]);
    if !ok(s) {
        return None;
    }
    let max = max_mm3.map(|m| (m / g.voxel_mm3()).floor().max(1.0) as usize);
    let mut out = Mask::empty(g.clone());
    let mut queue = VecDeque::from([s]);
    out.data[s] = true;
    let mut count = 1usize;
    let mut capped = false;
    let mut nb = [0usize; 6];
    'grow: while let Some(n) = queue.pop_front() {
        let c = g.neighbours(n, &mut nb);
        for &m in &nb[..c] {
            if !out.data[m] && ok(m) {
                if max.is_some_and(|max| count >= max) {
                    capped = true;
                    break 'grow;
                }
                out.data[m] = true;
                count += 1;
                queue.push_back(m);
            }
        }
    }
    Some((out, capped))
}

/// What a label holds, in mm and in the volume's values.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Stats {
    pub voxels: u64,
    pub volume_mm3: f64,
    /// Centre of mass, LPS mm. `None` when empty.
    pub centroid: Option<[f64; 3]>,
    /// Voxel box `[min, max]`, inclusive.
    pub bbox: Option<[[u32; 3]; 2]>,
    /// The longest extent across the label, voxel boxes included, mm (within about 1%).
    pub max_diameter_mm: f64,
    /// Over voxels with data; `None` when there are none.
    pub values: Option<ValueStats>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ValueStats {
    pub mean: f64,
    pub std: f64,
    pub min: f64,
    pub max: f64,
    /// 5th, 25th, 50th, 75th and 95th percentiles (nearest rank).
    pub p5: f64,
    pub p25: f64,
    pub p50: f64,
    pub p75: f64,
    pub p95: f64,
}

/// Statistics of a mask, with the values of `vol` under it when given.
pub fn stats(mask: &Mask, vol: Option<&Volume>) -> Stats {
    let g = &mask.grid;
    let mut sum = [0f64; 3];
    let mut voxels = 0u64;
    let mut values: Vec<i16> = Vec::new();
    for (n, _) in mask.data.iter().enumerate().filter(|(_, b)| **b) {
        voxels += 1;
        let p = g.ijk(n);
        for a in 0..3 {
            sum[a] += p[a] as f64;
        }
        if let Some(v) = vol {
            let x = v.values[n];
            if !(v.info.has_nodata && x == NODATA) {
                values.push(x);
            }
        }
    }
    let centroid = (voxels > 0).then(|| g.to_patient(sum.map(|s| s / voxels as f64)));
    let values = (!values.is_empty()).then(|| {
        values.sort_unstable();
        let n = values.len() as f64;
        let mean = values.iter().map(|v| *v as f64).sum::<f64>() / n;
        let var = values.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / n;
        let pct = |p: f64| values[((p / 100.0 * n).ceil() as usize).clamp(1, values.len()) - 1] as f64;
        ValueStats {
            mean,
            std: var.sqrt(),
            min: values[0] as f64,
            max: *values.last().expect("not empty") as f64,
            p5: pct(5.0),
            p25: pct(25.0),
            p50: pct(50.0),
            p75: pct(75.0),
            p95: pct(95.0),
        }
    });
    Stats {
        voxels,
        volume_mm3: voxels as f64 * g.voxel_mm3(),
        centroid,
        bbox: mask.bbox(),
        max_diameter_mm: max_diameter_mm(mask),
        values,
    }
}

/// The largest caliper width of the mask's voxel boxes over ~600 directions spread on the sphere:
/// the maximum diameter, short by at most about 1%. Only boundary voxels are projected.
pub fn max_diameter_mm(mask: &Mask) -> f64 {
    let g = &mask.grid;
    let mut nb = [0usize; 6];
    let mut pts: Vec<[f64; 3]> = Vec::new();
    for (n, _) in mask.data.iter().enumerate().filter(|(_, b)| **b) {
        let c = g.neighbours(n, &mut nb);
        if c < 6 || nb[..c].iter().any(|m| !mask.data[*m]) {
            let p = g.ijk(n);
            pts.push([0, 1, 2].map(|a| p[a] as f64 * g.spacing[a]));
        }
    }
    if pts.is_empty() {
        return 0.0;
    }
    // A Fibonacci sphere; a hemisphere would do, as widths are symmetric.
    let m = 1200;
    let golden = std::f64::consts::PI * (3.0 - 5f64.sqrt());
    let mut best = 0f64;
    for s in 0..m / 2 {
        let z = 1.0 - (s as f64 + 0.5) / m as f64 * 2.0;
        let r = (1.0 - z * z).sqrt();
        let t = golden * s as f64;
        let d = [r * t.cos(), r * t.sin(), z];
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for p in &pts {
            let x = p[0] * d[0] + p[1] * d[1] + p[2] * d[2];
            lo = lo.min(x);
            hi = hi.max(x);
        }
        let box_extent: f64 = (0..3).map(|a| d[a].abs() * g.spacing[a]).sum();
        best = best.max(hi - lo + box_extent);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::{DType, ValueMeaning};

    pub(crate) fn grid(dims: [u32; 3], spacing: [f64; 3]) -> Grid {
        Grid {
            dims,
            spacing,
            origin: [0.0; 3],
            direction: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
        }
    }

    fn volume(dims: [u32; 3], spacing: [f64; 3], f: impl Fn([f64; 3]) -> i16) -> Volume {
        let g = grid(dims, spacing);
        let values = (0..g.len())
            .map(|n| {
                let p = g.ijk(n);
                f([0, 1, 2].map(|a| p[a] as f64 * spacing[a]))
            })
            .collect();
        Volume {
            info: VolumeInfo {
                dims,
                spacing,
                origin: [0.0; 3],
                direction: g.direction,
                dtype: DType::I16,
                value: ValueMeaning::Raw,
                has_nodata: false,
                meta: Default::default(),
            },
            values,
        }
    }

    fn ball(c: [f64; 3], r: f64) -> impl Fn([f64; 3]) -> i16 {
        move |p| {
            let d2: f64 = (0..3).map(|a| (p[a] - c[a]).powi(2)).sum();
            if d2 <= r * r { 100 } else { 0 }
        }
    }

    #[test]
    fn a_ball_has_the_volume_and_diameter_of_a_ball() {
        // Anisotropic voxels, as CT.
        let v = volume([80, 80, 64], [0.5, 0.5, 0.625], ball([20.0, 20.0, 20.0], 12.0));
        let m = threshold(&v, Some(50.0), None);
        let s = stats(&m, Some(&v));
        let want = 4.0 / 3.0 * std::f64::consts::PI * 12f64.powi(3);
        assert!((s.volume_mm3 / want - 1.0).abs() < 0.02, "{} vs {want}", s.volume_mm3);
        assert!((s.max_diameter_mm - 24.0).abs() < 1.0, "{}", s.max_diameter_mm);
        let c = s.centroid.unwrap();
        assert!((0..3).all(|a| (c[a] - 20.0).abs() < 0.1), "{c:?}");
        let vs = s.values.unwrap();
        assert_eq!((vs.mean, vs.p50, vs.std), (100.0, 100.0, 0.0));
    }

    #[test]
    fn components_keep_and_drop() {
        // Three blocks: big, middle, small touching the border.
        let v = volume([30, 30, 30], [1.0; 3], |p| {
            let inb = |lo: f64, hi: f64| (0..3).all(|a| p[a] >= lo && p[a] <= hi);
            if inb(10.0, 19.0) || inb(22.0, 25.0) || inb(0.0, 1.0) { 1 } else { 0 }
        });
        let m = threshold(&v, Some(1.0), None);
        let (_, sizes) = components(&m);
        assert_eq!(&sizes[1..], &[8, 1000, 64]);
        assert_eq!(keep_largest(&m, 1).count(), 1000);
        assert_eq!(keep_largest(&m, 2).count(), 1064);
        assert_eq!(drop_smaller_than_mm3(&m, 50.0).count(), 1064);
        assert_eq!(drop_touching_border(&m).count(), 1064);
        assert_eq!(connected_to(&m, [23, 23, 23]).count(), 64);
        assert_eq!(connected_to(&m, [5, 5, 5]).count(), 0);
    }

    #[test]
    fn morphology_in_mm() {
        let g = grid([41, 41, 41], [1.0, 1.0, 2.0]);
        let mut m = Mask::empty(g.clone());
        m.data[g.index(20, 20, 20)] = true;
        let d = dilate_mm(&m, 4.0);
        // A ball of radius 4 mm on 1×1×2 mm voxels: ±4 along i and j, ±2 along k.
        assert!(d.data[g.index(24, 20, 20)] && !d.data[g.index(25, 20, 20)]);
        assert!(d.data[g.index(20, 20, 22)] && !d.data[g.index(20, 20, 23)]);
        assert!(!d.data[g.index(23, 23, 20)], "corner outside the ball");
        // Eroding by the same radius gives back the point.
        let e = erode_mm(&d, 4.0);
        assert_eq!(e.count(), 1);
        assert!(e.data[g.index(20, 20, 20)]);
    }

    #[test]
    fn fills_cavities_and_open_tubes() {
        let g = grid([20, 20, 20], [1.0; 3]);
        let mut m = Mask::full(g.clone());
        // Air outside a 2-voxel rim on i, j; a cavity in the middle; a tube along k end to end.
        for n in 0..g.len() {
            let [i, j, k] = g.ijk(n);
            let rim = !(2..18).contains(&i) || !(2..18).contains(&j);
            let cavity = (6..9).contains(&i) && (6..9).contains(&j) && (6..9).contains(&k);
            let tube = (12..14).contains(&i) && (12..14).contains(&j);
            if rim || cavity || tube {
                m.data[n] = false;
            }
        }
        let filled = fill_holes(&m);
        assert_eq!(filled.count(), 16 * 16 * 20);
    }

    #[test]
    fn region_grow_stops_at_its_range_and_cap() {
        let v = volume([40, 40, 40], [1.0; 3], ball([20.0, 20.0, 20.0], 8.0));
        let (m, capped) = region_grow(&v, [20, 20, 20], 50.0, 200.0, None, None).unwrap();
        assert!(!capped);
        assert_eq!(m.count(), threshold(&v, Some(50.0), None).count());
        let (m, capped) = region_grow(&v, [20, 20, 20], 50.0, 200.0, Some(100.0), None).unwrap();
        assert!(capped);
        assert_eq!(m.count(), 100);
        assert!(region_grow(&v, [0, 0, 0], 50.0, 200.0, None, None).is_none());
    }
}
