//! Writes the synthetic chest CT zip (spatial-design §10), then opens it the way the app will —
//! read in place, cached in bricks — and runs the medical skill's chest recipe over it, printing
//! how long each part takes.
//!
//! cargo run -p finx-spatial --release --example phantom -- <out.zip> [recipe.json]
#![allow(clippy::print_stdout)]

#[path = "../tests/common/phantom.rs"]
mod phantom;

use finx_spatial::volume::Volume;
use finx_spatial::{dicom, recipe, zipsrc};
use std::time::Instant;

const CHEST: &str = include_str!("../../finx-core/src/skills/system/medical-imaging/recipes/chest.json");

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args().nth(1).ok_or("give the zip to write")?;
    let json = match std::env::args().nth(2) {
        Some(path) => std::fs::read_to_string(path)?,
        None => CHEST.to_string(),
    };
    let out = std::path::PathBuf::from(out);
    let t = Instant::now();
    phantom::write_zip(&out)?;
    println!("wrote {} in {:.2?}: {}", out.display(), t.elapsed(), phantom::nodule_text());

    let cache = tempfile::tempdir()?;
    let t = Instant::now();
    let source = finx_spatial::open_source(&out, &zipsrc::Limits::default())?;
    let series = dicom::scan(source.as_ref())?;
    let (best, why) = dicom::pick(&series).ok_or("no usable series")?;
    println!("scanned {} series in {:.2?}; {why}", series.len(), t.elapsed());
    let t = Instant::now();
    let store = finx_spatial::build_cache(source.as_ref(), best, &cache.path().join("bricks"))?;
    println!(
        "brick cache: {} levels, {:.1} MB packed, in {:.2?}; identity {}",
        store.levels(),
        store.packed_bytes() as f64 / 1e6,
        t.elapsed(),
        best.identity()
    );
    let t = Instant::now();
    let volume = Volume::from_store(&store)?;
    println!("volume {:?} read back in {:.2?}", volume.info.dims, t.elapsed());

    let r = recipe::parse(&json)?;
    let t = Instant::now();
    recipe::run(&r, &volume, &mut |b| {
        let tris: Vec<String> = b.meshes.iter().map(|m| m.triangles().to_string()).collect();
        println!(
            "  {:<11} {:>8.1} cm³  triangles [{}]  {:>5} ms{}",
            b.id,
            b.stats.volume_mm3 / 1000.0,
            tris.join(", "),
            b.millis,
            if b.notes.is_empty() { String::new() } else { format!("  ({})", b.notes.join("; ")) }
        );
    })?;
    println!("recipe built in {:.2?}", t.elapsed());
    Ok(())
}
