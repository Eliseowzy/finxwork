//! The synthetic chest (spatial-design §10): read from its zip in place, cached in bricks, and its
//! shapes handed to the kernel as masks, the way a skill's script hands back structures. The
//! kernel measures and meshes them; it does not find them (the chest script's own results are
//! scored by `examples/ct_eval.rs`).
#![allow(clippy::print_stdout)]

mod common;

use common::phantom::{self, NODULE, Phantom};
use finx_spatial::volume::Volume;
use finx_spatial::algo::{self, Grid, Mask};
use finx_spatial::{dicom, mesh, zipsrc};
use std::sync::OnceLock;
use std::time::Instant;

struct Study {
    _dir: tempfile::TempDir,
    volume: Volume,
    identity: String,
}

fn study() -> &'static Study {
    static S: OnceLock<Study> = OnceLock::new();
    S.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("chest.zip");
        let t = Instant::now();
        phantom::write_zip(&zip).unwrap();
        println!("phantom zip written in {:?}", t.elapsed());
        let t = Instant::now();
        let source = finx_spatial::open_source(&zip, &zipsrc::Limits::default()).unwrap();
        let series = dicom::scan(source.as_ref()).unwrap();
        let (best, why) = dicom::pick(&series).unwrap();
        assert_eq!(best.uid, phantom::THIN_UID, "{why}");
        assert!(series.iter().any(|s| s.unusable.as_deref() == Some("ImageType LOCALIZER")));
        let cache = dir.path().join("cache");
        let store = finx_spatial::build_cache(source.as_ref(), best, &cache).unwrap();
        println!("scanned and cached from the zip in {:?}", t.elapsed());
        // Nothing of the zip's contents was written out: only the zip and the cache.
        let mut names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        names.sort();
        assert_eq!(names, ["cache", "chest.zip"]);
        let volume = Volume::from_store(&store).unwrap();
        assert_eq!(volume.info.dims, [phantom::N as u32, phantom::N as u32, phantom::SLICES as u32]);
        Study {
            identity: best.identity(),
            _dir: dir,
            volume,
        }
    })
}

fn near(id: &str, got: f64, want: f64, tolerance: f64) {
    println!("  {id}: {:.1} cm³, phantom {:.1} cm³ ({:+.1}%)", got / 1000.0, want / 1000.0, (got / want - 1.0) * 100.0);
    assert!((got / want - 1.0).abs() <= tolerance, "{id}: {got} vs {want}");
}

/// The voxels of the study whose centres are inside a shape.
fn mask_of(vol: &Volume, inside: impl Fn([f64; 3]) -> bool) -> Mask {
    let grid = Grid::of(&vol.info);
    let data = (0..grid.len())
        .map(|n| {
            let p = grid.ijk(n);
            inside(grid.to_patient([p[0] as f64, p[1] as f64, p[2] as f64]))
        })
        .collect();
    Mask { grid, data }
}

#[test]
fn the_identity_is_the_series() {
    assert_eq!(study().identity.len(), 64);
}

/// Masks of the phantom's own shapes: volumes agree with the shapes, values are the scan's, and
/// every surface is closed, finite and within the triangle cap.
#[test]
fn masks_handed_back_are_measured_and_meshed() {
    let vol = &study().volume;
    let p = Phantom::new();
    let lung = |x: [f64; 3]| p.in_lung(x) && !p.in_vessel(x);
    let shapes: [(&str, Box<dyn Fn([f64; 3]) -> bool>, f64); 5] = [
        ("body", Box::new(|x| p.in_body(x)), 0.02),
        ("lung_right", Box::new(|x| lung(x) && x[0] < 0.0), 0.02),
        ("airway", Box::new(|x| p.in_airway(x)), 0.05),
        ("vessels", Box::new(|x| p.in_lung(x) && p.in_vessel(x)), 0.10),
        ("bones", Box::new(|x| p.in_bone(x)), 0.05),
    ];
    for (id, inside, tolerance) in &shapes {
        let mask = mask_of(vol, inside);
        let t = Instant::now();
        let stats = algo::stats(&mask, Some(vol));
        let meshes = mesh::lods(&mesh::surface(&mask));
        println!("  {id}: {} triangles in {} levels, {:?}", meshes[0].triangles(), meshes.len(), t.elapsed());
        near(id, stats.volume_mm3, phantom::analytic_mm3(inside), *tolerance);
        assert!(!meshes.is_empty() && meshes[0].triangles() <= mesh::LOD0_TRIANGLES, "{id}");
        for m in &meshes {
            assert!(m.is_valid() && !m.is_empty(), "{id}");
            assert!(m.positions.iter().flatten().all(|c| c.is_finite()), "{id}");
        }
        match *id {
            // Patient right is LPS -x.
            "lung_right" => assert!(stats.centroid.unwrap()[0] < 0.0),
            "bones" => assert!(stats.values.as_ref().unwrap().p5 >= 200.0),
            _ => {}
        }
    }
}

/// The nodule is just a mask: its place, size and values come out of the generic statistics.
#[test]
fn a_small_mask_is_measured_where_it_is() {
    let vol = &study().volume;
    let p = Phantom::new();
    let (c, r, hu) = NODULE;
    let stats = algo::stats(&mask_of(vol, |x| p.in_nodule(x)), Some(vol));
    near("nodule", stats.volume_mm3, phantom::analytic_mm3(|x| p.in_nodule(x)), 0.05);
    let centre = stats.centroid.unwrap();
    assert!((0..3).all(|a| (centre[a] - c[a]).abs() < 1.5), "{centre:?}");
    assert!((stats.max_diameter_mm - 2.0 * r).abs() < 2.0, "{}", stats.max_diameter_mm);
    let mean = stats.values.as_ref().unwrap().mean;
    assert!((mean - hu).abs() < 30.0, "{mean}");
}

/// A scan that ends inside a structure says so.
#[test]
fn a_partial_scan_says_which_end_is_cut() {
    for (name, want) in [("no_lung_base", "-z"), ("no_trachea_top", "+z")] {
        let v = phantom::family().into_iter().find(|v| v.name == name).unwrap();
        let vol = phantom::volume(&v);
        let p = Phantom::with(v);
        assert_eq!(algo::cut_off(&mask_of(&vol, |x| p.in_lung(x))), [want], "{name}");
    }
}
