//! Where a study's files come from: a folder, or a zip read in place (spatial-design §3: "zip 不落盘
//! 解压"). Readers see only names and bytes, so a zip never leaves a copy of its files on disk.

use std::path::{Path, PathBuf};

/// One file of a source, by name; the bytes come from [`Source::read`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRef {
    /// A path in the folder, or the entry's name in the zip (decoded, `/`-separated).
    pub name: String,
    pub(crate) loc: Loc,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Loc {
    Path(PathBuf),
    /// Entry `index` of archive `archive` (0 is the zip itself, then each nested zip).
    Entry { archive: usize, index: usize },
}

pub trait Source: Sync {
    /// The files that start like DICOM (128 bytes, then `DICM`), in a stable order.
    fn files(&self) -> &[FileRef];
    /// A file's bytes.
    fn read(&self, file: &FileRef) -> std::io::Result<Vec<u8>>;
}

/// A DICOM Part 10 file has a 128-byte preamble, then `DICM`. Extensions say nothing: downloads
/// rename clashing files to `x.dcm.repeat_0`.
pub fn is_dicom(head: &[u8]) -> bool {
    head.len() >= 132 && &head[128..132] == b"DICM"
}

/// A folder (or one file), walked in name order. Hidden files and `__MACOSX` are left out.
pub struct Folder {
    files: Vec<FileRef>,
}

impl Folder {
    pub fn new(root: &Path) -> Self {
        let mut paths = Vec::new();
        walk(root, &mut paths);
        let files = paths
            .into_iter()
            .filter(|p| starts_dicom(p))
            .map(|p| FileRef {
                name: p.to_string_lossy().into_owned(),
                loc: Loc::Path(p),
            })
            .collect();
        Self { files }
    }
}

impl Source for Folder {
    fn files(&self) -> &[FileRef] {
        &self.files
    }

    fn read(&self, file: &FileRef) -> std::io::Result<Vec<u8>> {
        match &file.loc {
            Loc::Path(p) => std::fs::read(p),
            Loc::Entry { .. } => Err(std::io::Error::other("not a file of this folder")),
        }
    }
}

fn walk(root: &Path, out: &mut Vec<PathBuf>) {
    // Symbolic links are not followed: a folder from elsewhere may point anywhere.
    let Ok(meta) = std::fs::symlink_metadata(root) else {
        return;
    };
    if meta.is_file() {
        out.push(root.to_path_buf());
        return;
    }
    if !meta.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') || name == "__MACOSX" {
            continue;
        }
        walk(&path, out);
    }
}

fn starts_dicom(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 132];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok()
        && is_dicom(&head)
}
