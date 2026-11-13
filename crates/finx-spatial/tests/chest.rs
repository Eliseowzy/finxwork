//! The synthetic chest (spatial-design §10): read from its zip in place, cached in bricks, and the
//! medical skill's chest recipe run over it. Volumes are checked against the phantom's own shapes,
//! sampled at the same voxel centres.
#![allow(clippy::print_stdout)]

mod common;

use common::phantom::{self, NODULE, Phantom};
use finx_spatial::recipe::{self, Built};
use finx_spatial::volume::Volume;
use finx_spatial::{algo, dicom, mesh, zipsrc};
use std::sync::OnceLock;
use std::time::Instant;

const CHEST: &str = include_str!("../../finx-core/src/skills/system/medical-imaging/recipes/chest.json");

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

fn run(json: &str) -> Vec<Built> {
    let r = recipe::parse(json).unwrap();
    let s = study();
    let t = Instant::now();
    let mut order = Vec::new();
    let built = recipe::run(&r, &s.volume, &mut |b| {
        println!(
            "  {:<11} {:>8.1} cm³  {:>7} triangles in {} levels  {:>5} ms  {}",
            b.id,
            b.stats.volume_mm3 / 1000.0,
            b.meshes.first().map_or(0, mesh::Mesh::triangles),
            b.meshes.len(),
            b.millis,
            b.notes.join("; ")
        );
        order.push(b.id.clone());
    })
    .unwrap();
    println!("recipe built in {:?}", t.elapsed());
    assert_eq!(order, r.structures.iter().map(|s| s.id.clone()).collect::<Vec<_>>(), "one by one, in order");
    for b in &built {
        for m in &b.meshes {
            assert!(m.is_valid() && !m.is_empty(), "{}", b.id);
            assert!(m.positions.iter().flatten().all(|c| c.is_finite()), "{}", b.id);
        }
        if !b.hidden && b.stats.voxels > 0 {
            assert!(!b.meshes.is_empty(), "{}", b.id);
            assert!(b.meshes[0].triangles() <= mesh::LOD0_TRIANGLES, "{}", b.id);
        }
    }
    built
}

fn get<'a>(built: &'a [Built], id: &str) -> &'a Built {
    built.iter().find(|b| b.id == id).unwrap()
}

fn near(id: &str, got: f64, want: f64, tolerance: f64) {
    println!("  {id}: {:.1} cm³, phantom {:.1} cm³ ({:+.1}%)", got / 1000.0, want / 1000.0, (got / want - 1.0) * 100.0);
    assert!((got / want - 1.0).abs() <= tolerance, "{id}: {got} vs {want}");
}

#[test]
fn the_identity_is_the_series() {
    assert_eq!(study().identity.len(), 64);
}

#[test]
fn the_chest_recipe_builds_the_phantom() {
    let built = run(CHEST);
    let p = Phantom::new();
    near("body", get(&built, "body").stats.volume_mm3, phantom::analytic_mm3(|x| p.in_body(x)), 0.02);
    let lung = |x: [f64; 3]| p.in_lung(x) && !p.in_vessel(x);
    near("lungs", get(&built, "lungs").stats.volume_mm3, phantom::analytic_mm3(lung), 0.05);
    assert!(get(&built, "lungs").hidden && get(&built, "lungs").meshes.is_empty());
    let right = get(&built, "lung_right");
    near("lung_right", right.stats.volume_mm3, phantom::analytic_mm3(|x| lung(x) && x[0] < 0.0), 0.05);
    near("lung_left", get(&built, "lung_left").stats.volume_mm3, phantom::analytic_mm3(|x| lung(x) && x[0] > 0.0), 0.05);
    // Patient right is LPS -x.
    assert!(right.stats.centroid.unwrap()[0] < 0.0);
    let airway = get(&built, "airway");
    near("airway", airway.stats.volume_mm3, phantom::analytic_mm3(|x| p.in_airway(x)), 0.10);
    // The vessels inside the lungs closed over them: close to the phantom's own.
    let vessels = get(&built, "vessels");
    let want = phantom::analytic_mm3(|x| p.in_lung(x) && p.in_vessel(x));
    println!("  vessels: {:.1} cm³, vessels in the phantom's lungs {:.1} cm³", vessels.stats.volume_mm3 / 1000.0, want / 1000.0);
    near("vessels", vessels.stats.volume_mm3, want, 0.15);
    let bones = get(&built, "bones");
    assert!(bones.stats.values.as_ref().unwrap().p5 >= 200.0);
    assert!(bones.stats.volume_mm3 > 50_000.0);
}

/// Lungs closed over their vessels, vessels inside them, and the nodule grown from its centre:
/// how §5.2's example would read with the closing it needs.
#[test]
fn a_closed_lung_recipe_measures_vessels_and_the_nodule() {
    let (c, r, _) = NODULE;
    let json = format!(
        r##"{{ "structures": [
          {{ "id": "body", "name": "Body", "color": "#c8a48a",
            "steps": [ {{ "threshold": [-400, null] }}, {{ "keep_largest": 1 }}, {{ "fill_holes": true }} ] }},
          {{ "id": "lungs", "name": "Lungs", "color": "#4a90d9", "hidden": true,
            "steps": [ {{ "threshold": [null, -400] }}, {{ "inside": "body" }}, {{ "drop_touching_border": true }},
                       {{ "keep_largest": 2 }}, {{ "dilate_mm": 5 }}, {{ "erode_mm": 5 }} ] }},
          {{ "id": "vessels", "name": "Vessels", "color": "#e0607a",
            "steps": [ {{ "threshold": [-300, null] }}, {{ "inside": "lungs" }}, {{ "drop_smaller_than_mm3": 20 }} ] }},
          {{ "id": "nodule", "name": "Nodule", "color": "#ffcc00",
            "steps": [ {{ "inside": "lungs" }}, {{ "region_grow": {{ "seed": {:?}, "range": [-700, -300], "max_mm3": 2000 }} }} ] }}
        ] }}"##,
        c
    );
    let built = run(&json);
    let p = Phantom::new();
    near("vessels", get(&built, "vessels").stats.volume_mm3, phantom::analytic_mm3(|x| p.in_lung(x) && p.in_vessel(x)), 0.15);
    let nodule = get(&built, "nodule");
    near("nodule", nodule.stats.volume_mm3, phantom::analytic_mm3(|x| p.in_nodule(x)), 0.35);
    let centre = nodule.stats.centroid.unwrap();
    assert!((0..3).all(|a| (centre[a] - c[a]).abs() < 1.5), "{centre:?}");
    let d = nodule.stats.max_diameter_mm;
    assert!((d - 2.0 * r).abs() < 2.0, "{d}");
    let mean = nodule.stats.values.as_ref().unwrap().mean;
    assert!((mean - NODULE.2).abs() < 30.0, "{mean}");
    // The same in mm from the generic statistics: a nodule is just a label.
    assert_eq!(algo::stats(&nodule.mask, None).voxels, nodule.stats.voxels);
}
