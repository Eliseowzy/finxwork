//! A synthetic chest CT as a zip of DICOM files, for tests and demos that must not use anyone's
//! scan (spatial-design §10): body, two lungs with a notch for the heart, a trachea with its two
//! main bronchi, spine, ribs, branching vessels, and a ground-glass nodule of known place and size
//! low in the right lung, near the front. A scout image and a second, 5 mm series come along, as
//! in a real study, so picking the series is tested too.
//!
//! Shared by `examples/phantom.rs` and `tests/chest.rs`.
#![allow(dead_code)]

use dicom_core::{DataElement, PrimitiveValue, VR};
use dicom_dictionary_std::tags;
use dicom_object::{FileMetaTableBuilder, InMemDicomObject};
use std::io::Write;
use std::path::Path;

pub const N: i32 = 256;
pub const PX: f64 = 1.3; // mm per pixel
pub const SLICES: usize = 200;
pub const GAP: f64 = 1.25; // mm between slices
pub const THIN_UID: &str = "2.25.1001";
/// The nodule: centre in patient mm (LPS: x to the left, y to the back, z up), radius, HU.
pub const NODULE: ([f64; 3], f64, f64) = ([-62.0, -50.0, 95.0], 2.6, -520.0);

const LUNG_R: ([f64; 3], [f64; 3]) = ([-72.0, 6.0, 125.0], [56.0, 76.0, 95.0]);
const LUNG_L: ([f64; 3], [f64; 3]) = ([72.0, 6.0, 122.0], [50.0, 72.0, 90.0]);
const HEART: ([f64; 3], [f64; 3]) = ([22.0, -32.0, 80.0], [58.0, 46.0, 52.0]);
const CARINA: [f64; 3] = [0.0, -10.0, 175.0];

fn ellipsoid(p: [f64; 3], c: [f64; 3], r: [f64; 3]) -> f64 {
    (0..3).map(|a| ((p[a] - c[a]) / r[a]).powi(2)).sum()
}

fn seg_dist(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    let t = ((ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2])).clamp(0.0, 1.0);
    ((ap[0] - t * ab[0]).powi(2) + (ap[1] - t * ab[1]).powi(2) + (ap[2] - t * ab[2]).powi(2)).sqrt()
}

fn noise(x: f64, y: f64, z: f64) -> f64 {
    let v = (x * 12.9898 + y * 78.233 + z * 37.719).sin() * 43758.5453;
    v - v.floor() - 0.5
}

/// How a scan departs from the default phantom: who is in it and how it was taken. The default is
/// the phantom of the tests; the CT evaluation (`examples/ct_eval.rs`) runs the family.
#[derive(Clone, Debug)]
pub struct Variant {
    pub name: &'static str,
    /// Anatomy scaled about the origin (a child is about 0.6); pixel spacing scales with it.
    pub scale: f64,
    /// mm between slices.
    pub gap: f64,
    /// The scanned range, mm of the (unscaled) phantom: from, to.
    pub z: (f64, f64),
    /// Extra noise, HU standard deviation (low dose).
    pub sigma: f64,
    /// Contrast in the blood: vessels and the heart at this HU.
    pub contrast: Option<f64>,
    /// Fraction of lung (in 6 mm cells) destroyed down to -975 HU.
    pub emphysema: f64,
    /// A metal sphere behind the sternum, with streaks across its slices.
    pub metal: bool,
    /// Slices stored feet first (k runs down).
    pub feet_first: bool,
    /// Rows and columns run right-to-left and back-to-front, as in a prone scan.
    pub prone: bool,
    /// A gas bridge joining the two lungs in front of the heart (fused lungs).
    pub fused: bool,
    /// A closed air pocket inside the body near the patient's right edge at the top of the scan.
    pub side_pocket: bool,
}

impl Default for Variant {
    fn default() -> Self {
        Self { name: "default", scale: 1.0, gap: GAP, z: (0.0, (SLICES - 1) as f64 * GAP), sigma: 0.0, contrast: None, emphysema: 0.0, metal: false, feet_first: false, prone: false, fused: false, side_pocket: false }
    }
}

/// The family the evaluation runs: one departure each, so a regression names its cause.
pub fn family() -> Vec<Variant> {
    let d = Variant::default;
    vec![
        d(),
        Variant { name: "thick_5mm", gap: 5.0, ..d() },
        Variant { name: "low_dose", sigma: 60.0, ..d() },
        Variant { name: "contrast", contrast: Some(250.0), ..d() },
        Variant { name: "emphysema", emphysema: 0.35, ..d() },
        Variant { name: "child", scale: 0.6, ..d() },
        Variant { name: "no_trachea_top", z: (0.0, 170.0), ..d() },
        Variant { name: "no_lung_base", z: (60.0, (SLICES - 1) as f64 * GAP), ..d() },
        Variant { name: "feet_first", feet_first: true, ..d() },
        Variant { name: "prone", prone: true, ..d() },
        Variant { name: "metal", metal: true, ..d() },
        Variant { name: "fused_lungs", fused: true, ..d() },
        Variant { name: "side_air_pocket", side_pocket: true, ..d() },
        Variant { name: "very_noisy", sigma: 120.0, ..d() },
    ]
}

/// The gas bridge of `fused_lungs`: a box in the unscaled phantom's mm that reaches into both
/// lungs and crosses the midline in front of the heart. At y ∈ [-58, -52] the right lung spans
/// x up to ≈ -39 and the left from ≈ +43, so x ∈ [-50, 55] overlaps both.
const BRIDGE: ([f64; 3], [f64; 3]) = ([-50.0, -58.0, 110.0], [55.0, -52.0, 140.0]);

/// The closed air pocket of `side_air_pocket`: inside the body, outside lung and airway, at the
/// top of the scan, with a cross-section larger than the trachea's.
const POCKET: ([f64; 3], [f64; 3]) = ([-135.0, 10.0, 240.0], [8.0, 14.0, 12.0]);

fn in_box(p: [f64; 3], a: [f64; 3], b: [f64; 3]) -> bool {
    (0..3).all(|i| p[i] >= a[i] && p[i] <= b[i])
}

const METAL: [f64; 3] = [6.0, -96.0, 130.0];

pub struct Phantom {
    vessels: Vec<([f64; 3], [f64; 3], f64)>,
    v: Variant,
}

impl Default for Phantom {
    fn default() -> Self {
        Self::new()
    }
}

impl Phantom {
    pub fn new() -> Self {
        Self::with(Variant::default())
    }

    pub fn with(v: Variant) -> Self {
        let mut s: u64 = 7;
        let mut rnd = || {
            s = s * 16807 % 2147483647;
            s as f64 / 2147483647.0
        };
        let mut vessels = Vec::new();
        for side in [-1.0, 1.0] {
            let hilum = [side * 34.0, 4.0, 125.0];
            for _ in 0..10 {
                let (c, r) = if side < 0.0 { LUNG_R } else { LUNG_L };
                let t = [c[0] + side * rnd() * 0.55 * r[0], c[1] + (rnd() - 0.5) * 1.3 * r[1], c[2] + (rnd() - 0.5) * 1.5 * r[2]];
                let mid = [(hilum[0] + t[0]) / 2.0 + (rnd() - 0.5) * 12.0, (hilum[1] + t[1]) / 2.0 + (rnd() - 0.5) * 12.0, (hilum[2] + t[2]) / 2.0];
                vessels.push((hilum, mid, 4.0));
                vessels.push((mid, t, 2.0));
            }
        }
        Self { vessels, v }
    }

    pub fn in_body(&self, p: [f64; 3]) -> bool {
        let p = self.q(p);
        (p[0] / 158.0).powi(2) + ((p[1] - 8.0) / 112.0).powi(2) <= 1.0
    }

    /// Lung tissue and what runs through it (vessels, the nodule), less the heart's notch.
    /// The fused bridge counts as lung on both sides of the midline, heart or not.
    pub fn in_lung(&self, p: [f64; 3]) -> bool {
        let p = self.q(p);
        if self.v.fused && in_box(p, BRIDGE.0, BRIDGE.1) {
            return true;
        }
        (ellipsoid(p, LUNG_R.0, LUNG_R.1) < 1.0 || ellipsoid(p, LUNG_L.0, LUNG_L.1) < 1.0) && ellipsoid(p, HEART.0, HEART.1) > 1.0
    }

    pub fn in_vessel(&self, p: [f64; 3]) -> bool {
        let p = self.q(p);
        self.vessels.iter().any(|(a, b, r)| seg_dist(p, *a, *b) < *r)
    }

    pub fn in_airway(&self, p: [f64; 3]) -> bool {
        let p = self.q(p);
        seg_dist(p, [0.0, -10.0, 260.0], CARINA) < 8.0
            || [-1.0, 1.0].iter().any(|s| seg_dist(p, CARINA, [s * 12.0, -8.0, 160.0]) < 5.0)
    }

    pub fn in_nodule(&self, p: [f64; 3]) -> bool {
        let p = self.q(p);
        ellipsoid(p, NODULE.0, [NODULE.1; 3]) < 1.0
    }

    /// A patient point in the unscaled phantom's coordinates.
    fn q(&self, p: [f64; 3]) -> [f64; 3] {
        p.map(|c| c / self.v.scale)
    }

    pub fn in_bone(&self, p: [f64; 3]) -> bool {
        let [x, y, z] = self.q(p);
        if self.v.side_pocket && ellipsoid([x, y, z], POCKET.0, POCKET.1) < 1.0 {
            return false;
        }
        let body = (x / 158.0).powi(2) + ((y - 8.0) / 112.0).powi(2);
        body <= 1.0 && ((x * x + (y - 92.0).powi(2)).sqrt() < 17.0 || (body > 0.7 && body < 0.8 && (z / 9.0).sin().abs() > 0.82 && y > -95.0))
    }

    pub fn in_metal(&self, p: [f64; 3]) -> bool {
        self.v.metal && ellipsoid(self.q(p), METAL, [4.0; 3]) < 1.0
    }

    /// The scan's value at a point: the phantom's own, then what the variant does to it.
    pub fn hu(&self, p: [f64; 3]) -> f64 {
        let mut v = self.hu_base(p);
        let [x, y, z] = self.q(p);
        if self.v.contrast.is_some() || self.v.emphysema > 0.0 {
            if let Some(c) = self.v.contrast {
                if (self.in_vessel(p) && self.in_lung(p)) || (ellipsoid([x, y, z], HEART.0, HEART.1) < 1.0 && !self.in_lung(p) && !self.in_airway(p)) {
                    v = c + noise(x, y, z) * 30.0;
                }
            }
            if self.v.emphysema > 0.0 && self.in_lung(p) && !self.in_vessel(p) && !self.in_nodule(p) {
                let cell = noise((x / 6.0).floor(), (y / 6.0).floor(), (z / 6.0).floor()) + 0.5;
                if cell < self.v.emphysema {
                    v = -975.0 + noise(x, y, z) * 20.0;
                }
            }
        }
        if self.v.metal {
            let d = ((x - METAL[0]).powi(2) + (y - METAL[1]).powi(2)).sqrt();
            if self.in_metal(p) {
                v = 3000.0;
            } else if (z - METAL[2]).abs() < 6.0 && (x / 158.0).powi(2) + ((y - 8.0) / 112.0).powi(2) <= 1.0 {
                v += 500.0 * ((y - METAL[1]).atan2(x - METAL[0]) * 6.0).cos() * (-d / 60.0).exp();
            }
        }
        if self.v.sigma > 0.0 {
            let n = noise(x + 0.31, y + 0.77, z + 0.13) + noise(y + 1.7, z + 2.3, x + 0.5) + noise(z + 3.1, x + 4.7, y + 0.9);
            v += n * self.v.sigma * 2.0; // the sum of three uniforms on ±0.5 has σ 0.5
        }
        v
    }

    fn hu_base(&self, p: [f64; 3]) -> f64 {
        let [x, y, z] = self.q(p);
        let body = (x / 158.0).powi(2) + ((y - 8.0) / 112.0).powi(2);
        if body > 1.0 {
            return -1000.0 + noise(x, y, z) * 20.0;
        }
        let mut v = if body > 0.86 { -90.0 } else { 40.0 };
        if (x * x + (y - 92.0).powi(2)).sqrt() < 17.0 {
            v = 420.0;
        }
        if body > 0.7 && body < 0.8 && (z / 9.0).sin().abs() > 0.82 && y > -95.0 {
            v = 650.0;
        }
        if self.in_lung(p) {
            v = -860.0 + noise(x, y, z) * 60.0;
            if self.in_vessel(p) {
                v = 30.0;
            }
        }
        if self.v.side_pocket && ellipsoid([x, y, z], POCKET.0, POCKET.1) < 1.0 {
            v = -1000.0 + noise(x, y, z) * 20.0;
        }
        if self.in_airway(p) {
            v = -1000.0 + noise(x, y, z) * 20.0;
        }
        if self.in_nodule(p) {
            v = NODULE.2 + noise(x, y, z) * 40.0;
        }
        v
    }
}

/// The patient position of voxel (i, j) of a slice at height `z`.
pub fn at(i: i32, j: i32, z: f64) -> [f64; 3] {
    let half = (N as f64 - 1.0) / 2.0 * PX;
    [-half + i as f64 * PX, -half + j as f64 * PX, z]
}

#[allow(clippy::too_many_arguments)]
fn image(series: &str, number: i32, description: &str, image_type: &str, k: usize, z: f64, rows: &[i16], thickness: f64) -> Vec<u8> {
    let mut obj = InMemDicomObject::new_empty();
    let mut put = |tag, vr, value: PrimitiveValue| obj.put(DataElement::new(tag, vr, value));
    put(tags::SOP_CLASS_UID, VR::UI, "1.2.840.10008.5.1.4.1.1.2".into());
    put(tags::SOP_INSTANCE_UID, VR::UI, format!("{series}.{k}").into());
    put(tags::IMAGE_TYPE, VR::CS, image_type.into());
    put(tags::MODALITY, VR::CS, "CT".into());
    put(tags::BODY_PART_EXAMINED, VR::CS, "CHEST".into());
    put(tags::SERIES_INSTANCE_UID, VR::UI, series.into());
    put(tags::SERIES_NUMBER, VR::IS, number.to_string().into());
    put(tags::SERIES_DESCRIPTION, VR::LO, description.into());
    put(tags::CONVOLUTION_KERNEL, VR::SH, "LUNG".into());
    put(tags::SLICE_THICKNESS, VR::DS, format!("{thickness}").into());
    put(tags::INSTANCE_NUMBER, VR::IS, (k + 1).to_string().into());
    let p0 = at(0, 0, z);
    put(tags::IMAGE_POSITION_PATIENT, VR::DS, format!("{}\\{}\\{z}", p0[0], p0[1]).into());
    put(tags::IMAGE_ORIENTATION_PATIENT, VR::DS, "1\\0\\0\\0\\1\\0".into());
    put(tags::SAMPLES_PER_PIXEL, VR::US, PrimitiveValue::from(1u16));
    put(tags::PHOTOMETRIC_INTERPRETATION, VR::CS, "MONOCHROME2".into());
    put(tags::ROWS, VR::US, PrimitiveValue::from(N as u16));
    put(tags::COLUMNS, VR::US, PrimitiveValue::from(N as u16));
    put(tags::PIXEL_SPACING, VR::DS, format!("{PX}\\{PX}").into());
    put(tags::BITS_ALLOCATED, VR::US, PrimitiveValue::from(16u16));
    put(tags::BITS_STORED, VR::US, PrimitiveValue::from(16u16));
    put(tags::HIGH_BIT, VR::US, PrimitiveValue::from(15u16));
    put(tags::PIXEL_REPRESENTATION, VR::US, PrimitiveValue::from(1u16));
    put(tags::RESCALE_INTERCEPT, VR::DS, "-1024".into());
    put(tags::RESCALE_SLOPE, VR::DS, "1".into());
    let bytes: Vec<u8> = rows.iter().flat_map(|v| v.to_le_bytes()).collect();
    put(tags::PIXEL_DATA, VR::OW, PrimitiveValue::U8(bytes.into()));
    let file = obj.with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1")).expect("meta");
    let mut out = Vec::new();
    file.write_all(&mut out).expect("write");
    out
}

/// Writes the study as a zip: the 1.25 mm series, a 5 mm series and a scout.
pub fn write_zip(out: &Path) -> std::io::Result<()> {
    let phantom = Phantom::new();
    let slice = |z: f64| -> Vec<i16> {
        (0..N).flat_map(|j| (0..N).map(move |i| (i, j))).map(|(i, j)| (phantom.hu(at(i, j, z)) + 1024.0).round() as i16).collect()
    };
    let mut zip = zip::ZipWriter::new(std::fs::File::create(out)?);
    let opts = zip::write::SimpleFileOptions::default();
    for k in 0..SLICES {
        let z = k as f64 * GAP;
        zip.start_file(format!("CHEST/thin/IM{k:04}"), opts)?;
        zip.write_all(&image(THIN_UID, 4, "Phantom 1.25mm", "ORIGINAL\\PRIMARY\\AXIAL", k, z, &slice(z), GAP))?;
    }
    for k in 0..SLICES / 4 {
        let z = k as f64 * 5.0;
        zip.start_file(format!("CHEST/thick/IM{k:04}"), opts)?;
        zip.write_all(&image("2.25.1002", 2, "Phantom 5mm", "ORIGINAL\\PRIMARY\\AXIAL", k, z, &slice(z), 5.0))?;
    }
    zip.start_file("CHEST/scout/IM0000", opts)?;
    zip.write_all(&image("2.25.1000", 1, "Scout", "ORIGINAL\\PRIMARY\\LOCALIZER", 0, 0.0, &slice(125.0), 1.0))?;
    zip.finish()?;
    Ok(())
}

/// mm³ of the thin series' voxels whose centres satisfy `f`.
pub fn analytic_mm3(f: impl Fn([f64; 3]) -> bool) -> f64 {
    let mut n = 0u64;
    for k in 0..SLICES {
        let z = k as f64 * GAP;
        for j in 0..N {
            for i in 0..N {
                if f(at(i, j, z)) {
                    n += 1;
                }
            }
        }
    }
    n as f64 * PX * PX * GAP
}

/// Where the nodule is, as the example prints it.
pub fn nodule_text() -> String {
    let (c, r, h) = NODULE;
    let half = (N as f64 - 1.0) / 2.0 * PX;
    let k = |z: f64| (z / GAP).round() as i32;
    let ij = |v: f64| ((v + half) / PX).round() as i32;
    format!(
        "nodule {:.1} mm across, {h} HU, centre LPS {c:?} mm = voxel [{}, {}, {}] (axial slices {}–{} of {SLICES} in the 1.25 mm series), patient's right lung near the front",
        2.0 * r,
        ij(c[0]),
        ij(c[1]),
        k(c[2]),
        k(c[2] - r) + 1,
        k(c[2] + r) + 1,
    )
}

/// The variant's scan straight into memory (no DICOM): the evaluation's way in. The thin series'
/// grid, its pixels scaled with the anatomy, over the variant's range and slice gap, in the
/// variant's orientation.
pub fn volume(v: &Variant) -> finx_spatial::volume::Volume {
    use finx_spatial::volume::{DType, ValueMeaning, Volume, VolumeInfo};
    let phantom = Phantom::with(v.clone());
    let s = v.scale;
    let (z0, z1) = (v.z.0 * s, v.z.1 * s);
    let k = ((z1 - z0) / v.gap).floor() as u32 + 1;
    let px = PX * s;
    let half = (N as f64 - 1.0) / 2.0 * px;
    let (di, dj, ox, oy) = if v.prone { ([-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], half, half) } else { ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], -half, -half) };
    let (dk, oz) = if v.feet_first { ([0.0, 0.0, -1.0], z0 + (k - 1) as f64 * v.gap) } else { ([0.0, 0.0, 1.0], z0) };
    let info = VolumeInfo {
        dims: [N as u32, N as u32, k],
        spacing: [px, px, v.gap],
        origin: [ox, oy, oz],
        direction: [di, dj, dk],
        dtype: DType::I16,
        value: ValueMeaning::Calibrated { unit: "HU".into() },
        has_nodata: false,
        meta: Default::default(),
    };
    let mut values = Vec::with_capacity(info.voxels());
    for kk in 0..k {
        for j in 0..N {
            for i in 0..N {
                let p = finx_spatial::volume::to_patient(&info, [i as f64, j as f64, kk as f64]);
                values.push(phantom.hu(p).round().clamp(-1024.0, 3071.0) as i16);
            }
        }
    }
    Volume { info, values }
}
