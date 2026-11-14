//! The 3D kernel (docs/desktop/spatial-design.md §4.1). Generic: no industry words. Readers find
//! formats by content, volumes go to a brick cache, and masks are measured and meshed. Dividing a
//! volume into structures is not done here: a skill's script does it and hands back masks (§5.2).

pub mod algo;
pub mod brick;
pub mod dicom;
pub mod mesh;
pub mod render;
pub mod source;
pub mod volume;
pub mod zipsrc;

/// Hex sha256 of some bytes: the identity of a mesh file (§3).
pub fn content_id(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, bytes).as_ref())
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error(transparent)]
    Zip(#[from] zipsrc::ZipError),
    #[error(transparent)]
    Dicom(#[from] dicom::DicomError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// A study's files: a zip (found by content, read in place) or a folder.
pub fn open_source(path: &Path, limits: &zipsrc::Limits) -> Result<Box<dyn source::Source>, ImportError> {
    use std::io::Read;
    let mut head = [0u8; 4];
    let is_zip = path.is_file()
        && std::fs::File::open(path)
            .and_then(|mut f| f.read_exact(&mut head))
            .is_ok()
        && &head == b"PK\x03\x04";
    Ok(if is_zip {
        Box::new(zipsrc::ZipSource::open(path, limits)?)
    } else {
        Box::new(source::Folder::new(path))
    })
}

/// Reads a series into a brick cache at `dir` (written beside it, then renamed into place).
pub fn build_cache(source: &dyn source::Source, series: &dicom::SeriesInfo, dir: &Path) -> Result<brick::BrickStore, ImportError> {
    let mut writer = brick::BrickWriter::create(dir)?;
    dicom::read_into(source, series, &mut writer)?;
    Ok(writer.finish()?)
}
