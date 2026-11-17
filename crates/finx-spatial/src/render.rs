//! Slices as images (spatial-design §10.1 `voxel_slice`): a plane of the volume cut from the
//! bricks, laid out the way slices are read, at its true shape in mm, through a value window,
//! with a scale bar. The facts that go with the image (what each edge faces, mm per pixel) come
//! back beside it, so the model never estimates them from the picture (VD-12).
//!
//! Layout, as radiology reads them (the canvas does the same):
//! - axial: i to the right, j down — with the usual directions the image's left is the
//!   patient's right and its top is the front;
//! - coronal: i to the right, the head up;
//! - sagittal: j to the right (front on the left), the head up.

use crate::brick::{BRICK, BrickStore, brick_extent};
use crate::volume::NODATA;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plane {
    Axial,
    Coronal,
    Sagittal,
}

impl Plane {
    /// The axis held fixed: k, j or i.
    pub fn fixed(self) -> usize {
        match self {
            Self::Axial => 2,
            Self::Coronal => 1,
            Self::Sagittal => 0,
        }
    }

    /// The axes running right and down in the image, before the head is put up.
    fn axes(self) -> (usize, usize) {
        match self {
            Self::Axial => (0, 1),
            Self::Coronal => (0, 2),
            Self::Sagittal => (1, 2),
        }
    }
}

/// A plane of level 0, `w * h` values, `u` (the first in-plane axis) fastest.
pub struct PlaneValues {
    pub values: Vec<i16>,
    pub w: u32,
    pub h: u32,
}

/// Cuts a plane at `index` along the plane's fixed axis, reading only the bricks it crosses.
pub fn cut(store: &BrickStore, plane: Plane, index: u32) -> std::io::Result<PlaneValues> {
    let dims = store.level_dims(0);
    let fixed = plane.fixed();
    if index >= dims[fixed] {
        return Err(std::io::Error::other(format!("index {index} is past the volume's {} along this axis", dims[fixed])));
    }
    let (u, v) = plane.axes();
    let (w, h) = (dims[u], dims[v]);
    let mut out = vec![0i16; (w * h) as usize];
    let nb = dims.map(|d| d.div_ceil(BRICK));
    let bf = index / BRICK;
    for bv in 0..nb[v] {
        for bu in 0..nb[u] {
            let mut b = [0u32; 3];
            b[fixed] = bf;
            b[u] = bu;
            b[v] = bv;
            let ext = brick_extent(dims, b);
            let brick = store.brick(0, b)?;
            let at = |i: u32, j: u32, k: u32| brick[((k * ext[1] + j) * ext[0] + i) as usize];
            for y in 0..ext[v] {
                for x in 0..ext[u] {
                    let mut p = [0u32; 3];
                    p[fixed] = index - bf * BRICK;
                    p[u] = x;
                    p[v] = y;
                    let value = at(p[0], p[1], p[2]);
                    out[((bv * BRICK + y) * w + bu * BRICK + x) as usize] = value;
                }
            }
        }
    }
    Ok(PlaneValues { values: out, w, h })
}

/// An image of a plane, and what it shows.
pub struct Image {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// mm per image pixel, both ways.
    pub mm_per_px: f64,
    /// Whether the plane's second axis runs from the bottom up.
    pub flipped: bool,
    /// The scale bar's length.
    pub bar_mm: f64,
    /// The region shown, in voxels of the plane's two axes: `[u0, u1)` and `[v0, v1)`.
    pub u_range: (u32, u32),
    pub v_range: (u32, u32),
}

pub struct RenderOptions {
    /// Values mapped from black to white.
    pub window: (f64, f64),
    /// The region, in voxels of the plane: `[u0, u1)`, `[v0, v1)`; the whole plane by default.
    pub region: Option<((u32, u32), (u32, u32))>,
    /// The image's longer side, in pixels.
    pub size: u32,
    /// Draw the plane's second axis from the bottom up: for coronal and sagittal planes whose
    /// slices run towards the head, so the head is at the top.
    pub flip_v: bool,
}

/// Renders a plane at its true shape: each image pixel is `mm_per_px` both ways, sampled with
/// bilinear interpolation between voxels; no data is black.
pub fn render(p: &PlaneValues, spacing: (f64, f64), o: &RenderOptions) -> Image {
    let ((u0, u1), (v0, v1)) = o.region.unwrap_or(((0, p.w), (0, p.h)));
    let (u0, u1, v0, v1) = (u0.min(p.w - 1), u1.clamp(u0 + 1, p.w), v0.min(p.h - 1), v1.clamp(v0 + 1, p.h));
    let (wmm, hmm) = ((u1 - u0) as f64 * spacing.0, (v1 - v0) as f64 * spacing.1);
    let mm_per_px = wmm.max(hmm) / o.size as f64;
    let width = ((wmm / mm_per_px).round() as u32).max(1);
    let height = ((hmm / mm_per_px).round() as u32).max(1);
    let (lo, hi) = o.window;
    let sample = |x: f64, y: f64| -> Option<f64> {
        // Voxel centres sit at integer coordinates.
        let (fx, fy) = (x.clamp(0.0, (p.w - 1) as f64), y.clamp(0.0, (p.h - 1) as f64));
        let (x0, y0) = (fx.floor() as u32, fy.floor() as u32);
        let (x1, y1) = ((x0 + 1).min(p.w - 1), (y0 + 1).min(p.h - 1));
        let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
        let mut sum = 0.0;
        let mut weight = 0.0;
        for (xx, yy, wgt) in [(x0, y0, (1.0 - tx) * (1.0 - ty)), (x1, y0, tx * (1.0 - ty)), (x0, y1, (1.0 - tx) * ty), (x1, y1, tx * ty)] {
            let v = p.values[(yy * p.w + xx) as usize];
            if v != NODATA && wgt > 0.0 {
                sum += v as f64 * wgt;
                weight += wgt;
            }
        }
        (weight > 0.0).then(|| sum / weight)
    };
    let mut rgb = vec![0u8; (width * height * 3) as usize];
    for py in 0..height {
        // Image rows from the top; flipped, the plane's second axis runs bottom to top.
        let row = if o.flip_v { height - 1 - py } else { py };
        let y = v0 as f64 + (row as f64 + 0.5) * mm_per_px / spacing.1 - 0.5;
        for px in 0..width {
            let x = u0 as f64 + (px as f64 + 0.5) * mm_per_px / spacing.0 - 0.5;
            let g = match sample(x, y) {
                None => 0,
                Some(v) => (((v - lo) / (hi - lo)) * 255.0).clamp(0.0, 255.0) as u8,
            };
            let i = ((py * width + px) * 3) as usize;
            rgb[i..i + 3].copy_from_slice(&[g, g, g]);
        }
    }
    // A scale bar at the bottom left: a round length near a fifth of the width.
    let bar_mm = [1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0].into_iter().rev().find(|mm| mm / mm_per_px <= width as f64 / 4.0).unwrap_or(1.0);
    let bar_px = (bar_mm / mm_per_px).round() as u32;
    let (bx, by) = (8.min(width.saturating_sub(1)), height.saturating_sub(10));
    for y in by..(by + 3).min(height) {
        for x in bx..(bx + bar_px).min(width) {
            let i = ((y * width + x) * 3) as usize;
            rgb[i..i + 3].copy_from_slice(&[255, 210, 0]);
        }
    }
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("PNG header into memory");
        writer.write_image_data(&rgb).expect("PNG data into memory");
    }
    Image { png, width, height, mm_per_px, flipped: o.flip_v, bar_mm, u_range: (u0, u1), v_range: (v0, v1) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brick::BrickWriter;
    use crate::volume::{BrickSink, DType, ValueMeaning, VolumeInfo};

    fn store(dir: &std::path::Path, dims: [u32; 3], f: impl Fn(u32, u32, u32) -> i16) -> BrickStore {
        let info = VolumeInfo {
            dims,
            spacing: [0.5, 0.5, 2.0],
            origin: [0.0; 3],
            direction: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            dtype: DType::I16,
            value: ValueMeaning::Calibrated { unit: "HU".into() },
            has_nodata: true,
            meta: Default::default(),
        };
        let mut w = BrickWriter::create(&dir.join("c")).unwrap();
        w.begin(&info).unwrap();
        for k in 0..dims[2] {
            let s: Vec<i16> = (0..dims[1]).flat_map(|j| (0..dims[0]).map(move |i| (i, j))).map(|(i, j)| f(i, j, k)).collect();
            w.slice(&s).unwrap();
        }
        w.finish().unwrap()
    }

    #[test]
    fn planes_cut_across_bricks_hold_the_right_voxels() {
        let dir = tempfile::tempdir().unwrap();
        let dims = [70, 66, 67];
        let f = |i: u32, j: u32, k: u32| (i + 100 * j + 10_000 * (k % 3)) as i16;
        let s = store(dir.path(), dims, f);
        for (plane, index) in [(Plane::Axial, 65), (Plane::Coronal, 64), (Plane::Sagittal, 69)] {
            let p = cut(&s, plane, index).unwrap();
            let (u, v) = plane.axes();
            assert_eq!((p.w, p.h), (dims[u], dims[v]));
            for y in [0, 1, 63, 64, p.h - 1] {
                for x in [0, 63, 64, p.w - 1] {
                    let mut at = [0u32; 3];
                    at[plane.fixed()] = index;
                    at[u] = x;
                    at[v] = y;
                    assert_eq!(p.values[(y * p.w + x) as usize], f(at[0], at[1], at[2]), "{plane:?} {x},{y}");
                }
            }
        }
        assert!(cut(&s, Plane::Axial, 67).is_err());
    }

    #[test]
    fn an_image_has_the_true_shape_and_puts_the_head_up() {
        // Rows 0.5 mm apart, slices 2 mm apart: a coronal plane 10 × 4 voxels is 5 × 8 mm.
        let dir = tempfile::tempdir().unwrap();
        // Bright at the top slice (k = 3), dark below.
        let s = store(dir.path(), [10, 10, 4], |_, _, k| if k == 3 { 1000 } else { -1000 });
        let p = cut(&s, Plane::Coronal, 5).unwrap();
        let o = RenderOptions { window: (-1000.0, 1000.0), region: None, size: 80, flip_v: true };
        let img = render(&p, (0.5, 2.0), &o);
        assert_eq!((img.width, img.height), (50, 80));
        assert!((img.mm_per_px - 0.1).abs() < 1e-9);
        let decoded = png::Decoder::new(std::io::Cursor::new(img.png));
        let mut reader = decoded.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut buf).unwrap();
        let grey = |x: u32, y: u32| buf[((y * 50 + x) * 3) as usize];
        assert_eq!(grey(25, 2), 255, "the head's slice is at the top");
        assert_eq!(grey(25, 40), 0);
        assert!(img.bar_mm > 0.0);
    }

    #[test]
    fn no_data_is_black_and_a_region_is_shown_alone() {
        let dir = tempfile::tempdir().unwrap();
        let s = store(dir.path(), [20, 20, 2], |i, _, _| if i < 10 { NODATA } else { 1000 });
        let p = cut(&s, Plane::Axial, 0).unwrap();
        let whole = render(&p, (0.5, 0.5), &RenderOptions { window: (-1000.0, 1000.0), region: None, size: 40, flip_v: false });
        assert_eq!((whole.width, whole.height), (40, 40));
        let part = render(&p, (0.5, 0.5), &RenderOptions { window: (-1000.0, 1000.0), region: Some(((10, 20), (0, 5))), size: 100, flip_v: false });
        assert_eq!((part.width, part.height), (100, 50));
        assert_eq!(part.u_range, (10, 20));
    }
}
