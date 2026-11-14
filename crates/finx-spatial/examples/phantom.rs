//! Writes the synthetic chest CT zip (spatial-design §10), then opens it the way the app will —
//! read in place, cached in bricks — printing how long each part takes. The chest script's
//! results on it are scored by `ct_eval`.
//!
//! cargo run -p finx-spatial --release --example phantom -- <out.zip>
#![allow(clippy::print_stdout)]

#[path = "../tests/common/phantom.rs"]
mod phantom;

use finx_spatial::volume::Volume;
use finx_spatial::{dicom, zipsrc};
use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args().nth(1).ok_or("give the zip to write")?;
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
    Ok(())
}
