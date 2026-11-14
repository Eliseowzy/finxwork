//! What the kernel does with a volume and its masks (spatial-design §4.1): the grid, statistics
//! and measurement. Nothing here knows what the values mean, and nothing here segments: how a
//! volume is divided into structures is a skill's script's business (§5.2).

use crate::volume::{NODATA, Volume, VolumeInfo};

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

/// The ends of the head-foot axis a mask touches (`"superior"`, `"inferior"`): it goes on beyond
/// what was scanned, so its volume is of the scanned part only.
pub fn cut_off(mask: &Mask) -> Vec<&'static str> {
    let g = &mask.grid;
    let axis = (0..3).max_by(|a, b| g.direction[*a][2].abs().total_cmp(&g.direction[*b][2].abs())).unwrap_or(2);
    let Some([lo, hi]) = mask.bbox() else { return Vec::new() };
    let up = g.direction[axis][2] > 0.0;
    let mut out = Vec::new();
    if hi[axis] + 1 == g.dims[axis] {
        out.push(if up { "superior" } else { "inferior" });
    }
    if lo[axis] == 0 {
        out.push(if up { "inferior" } else { "superior" });
    }
    out
}

/// A first look at a volume, before deciding how to segment it: how far it reaches, how its
/// values spread, how noisy it is. Facts only; what they mean is the reader's (a skill's) to say.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Survey {
    /// The scanned extent along i, j, k, mm.
    pub extent_mm: [f64; 3],
    /// The patient side each of i, j, k runs towards (`L`, `P`, `S`, …).
    pub towards: [char; 3],
    pub min: f64,
    pub max: f64,
    /// Bins `width` wide from `start`: mL of voxels in each (voxels without data left out).
    pub histogram: Histogram,
    /// The least standard deviation over 16-voxel cubes at the volume's corners and edge
    /// mid-points that vary at all: the noise of the emptiest background. `None` when all are flat.
    pub background_sigma: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Histogram {
    pub start: f64,
    pub width: f64,
    pub ml: Vec<f64>,
}

/// See [`Survey`]. The histogram's bins are `width` wide.
pub fn survey(vol: &Volume, width: f64) -> Survey {
    let g = Grid::of(&vol.info);
    let nodata = vol.info.has_nodata;
    let (mut min, mut max) = (i16::MAX, i16::MIN);
    for &v in &vol.values {
        if !(nodata && v == NODATA) {
            min = min.min(v);
            max = max.max(v);
        }
    }
    if min > max {
        (min, max) = (0, 0);
    }
    let start = (min as f64 / width).floor() * width;
    let bins = (((max as f64 - start) / width).floor() as usize) + 1;
    let mut count = vec![0u64; bins];
    for &v in &vol.values {
        if !(nodata && v == NODATA) {
            count[((v as f64 - start) / width) as usize] += 1;
        }
    }
    let ml = g.voxel_mm3() / 1000.0;
    // Background noise: small cubes at the corners and the middles of the in-plane edges.
    let side = 16u32;
    let mut sigma: Option<f64> = None;
    if g.dims.iter().all(|d| *d >= side * 2) {
        let at = |a: usize, t: u32| match t {
            0 => 0,
            1 => (g.dims[a] - side) / 2,
            _ => g.dims[a] - side,
        };
        for ti in 0..3 {
            for tj in 0..3 {
                for tk in 0..3 {
                    if ti == 1 && tj == 1 {
                        continue;
                    }
                    let (i0, j0, k0) = (at(0, ti), at(1, tj), at(2, tk));
                    let (mut n, mut sum, mut sq) = (0f64, 0f64, 0f64);
                    for k in k0..k0 + side {
                        for j in j0..j0 + side {
                            for i in i0..i0 + side {
                                let v = vol.values[g.index(i, j, k)];
                                if !(nodata && v == NODATA) {
                                    n += 1.0;
                                    sum += v as f64;
                                    sq += (v as f64).powi(2);
                                }
                            }
                        }
                    }
                    if n > 100.0 {
                        let sd = (sq / n - (sum / n).powi(2)).max(0.0).sqrt();
                        if sd > 0.5 && sigma.is_none_or(|s| sd < s) {
                            sigma = Some(sd);
                        }
                    }
                }
            }
        }
    }
    Survey {
        extent_mm: [0, 1, 2].map(|a| g.dims[a] as f64 * g.spacing[a]),
        towards: [0, 1, 2].map(|a| crate::volume::side_of(g.direction[a])),
        min: min as f64,
        max: max as f64,
        histogram: Histogram { start, width, ml: count.iter().map(|c| *c as f64 * ml).collect() },
        background_sigma: sigma,
    }
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
        let m = Mask { grid: Grid::of(&v.info), data: v.values.iter().map(|x| *x >= 50).collect() };
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
    fn says_which_ends_of_the_scan_a_mask_runs_into() {
        let g = grid([8, 8, 10], [1.0; 3]);
        let slab = |from: u32, to: u32| {
            let mut m = Mask::empty(g.clone());
            for k in from..to {
                m.data[g.index(4, 4, k)] = true;
            }
            m
        };
        assert!(cut_off(&slab(3, 6)).is_empty());
        assert_eq!(cut_off(&slab(0, 4)), ["inferior"]);
        assert_eq!(cut_off(&slab(5, 10)), ["superior"]);
        assert_eq!(cut_off(&slab(0, 10)), ["superior", "inferior"]);
        // Slices stored feet last: the first slice is the head end.
        let mut down = slab(0, 4);
        down.grid.direction[2][2] = -1.0;
        assert_eq!(cut_off(&down), ["superior"]);
    }
}
