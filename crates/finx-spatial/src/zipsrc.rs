//! A zip read in place (spatial-design §3, §4.1). The archive comes from the user, but its contents
//! are untrusted: it may have been sent by someone else, and it holds names and record numbers we
//! must not copy into our folders. So nothing is unpacked to disk: DICOM files are read from the
//! zip stream straight into the brick cache.
//!
//! - Paths that leave the archive (`../`, absolute paths) and symbolic links are refused.
//! - The total size, the number of files and each file's compression ratio are capped, counted on
//!   the bytes actually inflated rather than on what the headers claim.
//! - `__MACOSX/` and `.DS_Store` are skipped, and entries sharing a name are reported; a zip inside
//!   the zip is read once (in memory), no deeper.
//! - Names that are not UTF-8 are read as GBK (Windows archives made in China), else escaped.
//! - Nothing in the archive is run, and a password-protected archive is refused.

use crate::source::{FileRef, Loc, Source, is_dicom};
use std::io::{Cursor, Read, Seek};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum ZipError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("not a readable zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("the archive is password protected; unpack it yourself and open the folder")]
    Encrypted,
    #[error("the archive unpacks to more than {0} bytes")]
    TooLarge(u64),
    #[error("the archive has more than {0} files")]
    TooManyFiles(usize),
    #[error("{name} inflates more than {ratio} times its packed size")]
    Ratio { name: String, ratio: u64 },
}

type Result<T> = std::result::Result<T, ZipError>;

#[derive(Clone, Debug)]
pub struct Limits {
    /// Inflated bytes, all files together (nested zips included).
    pub max_total: u64,
    pub max_files: usize,
    /// Inflated bytes over packed bytes, per file. CT images pack a few times at most; a zip bomb
    /// packs thousands of times. Files under 1 MiB are not held to it.
    pub max_ratio: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_total: 8 << 30,
            max_files: 200_000,
            max_ratio: 200,
        }
    }
}

/// An entry that was not read, and why.
#[derive(Clone, Debug, PartialEq)]
pub struct Skipped {
    pub name: String,
    pub reason: &'static str,
}

/// What opening the archive found.
#[derive(Clone, Debug, Default)]
pub struct ZipReport {
    /// Files read (DICOM or not).
    pub files: usize,
    /// Inflated bytes read.
    pub bytes: u64,
    /// Entries under `__MACOSX/` and `.DS_Store` files, left out without listing each.
    pub litter: usize,
    pub skipped: Vec<Skipped>,
}

trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}

type Archive = zip::ZipArchive<Box<dyn ReadSeek>>;

/// A zip opened as a [`Source`]: its DICOM files, read from the archive when asked.
pub struct ZipSource {
    archives: Vec<Option<Mutex<Archive>>>,
    files: Vec<FileRef>,
    limits: Limits,
    pub report: ZipReport,
}

/// An entry's name as text: UTF-8, else GBK, else `%XX` escapes for the bytes.
pub fn decode_name(raw: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    if let Some(s) = encoding_rs::GBK.decode_without_bom_handling_and_without_replacement(raw) {
        return s.into_owned();
    }
    raw.iter()
        .map(|&b| {
            if b.is_ascii_graphic() || b == b' ' {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// A name made safe as a relative path, or why it is not. Windows archives may use `\` between
/// folders; it is read after decoding, since a GBK character's second byte can be 0x5C.
fn relative_path(name: &str) -> std::result::Result<PathBuf, &'static str> {
    if name.contains('\0') {
        return Err("NUL in name");
    }
    let name = name.replace('\\', "/");
    let mut out = PathBuf::new();
    for part in Path::new(&name).components() {
        match part {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("path leaves the folder");
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("empty name");
    }
    Ok(out)
}

fn junk(path: &Path) -> bool {
    path.components().any(|c| {
        let c = c.as_os_str();
        c == "__MACOSX" || c == ".DS_Store"
    })
}

/// Reads at most `cap + 1` bytes: one more tells that the cap was passed.
fn read_capped(from: &mut impl Read, cap: u64) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    from.take(cap.saturating_add(1)).read_to_end(&mut out)?;
    Ok(out)
}

fn ratio_cap(compressed: u64, limits: &Limits) -> u64 {
    compressed
        .max(1)
        .saturating_mul(limits.max_ratio)
        .max(1 << 20)
}

impl ZipSource {
    pub fn open(path: &Path, limits: &Limits) -> Result<Self> {
        let file = std::io::BufReader::new(std::fs::File::open(path)?);
        Self::from_reader(Box::new(file), limits)
    }

    /// An archive held in memory.
    pub fn from_bytes(bytes: Vec<u8>, limits: &Limits) -> Result<Self> {
        Self::from_reader(Box::new(Cursor::new(bytes)), limits)
    }

    fn from_reader(reader: Box<dyn ReadSeek>, limits: &Limits) -> Result<Self> {
        let mut s = Self {
            archives: Vec::new(),
            files: Vec::new(),
            limits: limits.clone(),
            report: ZipReport::default(),
        };
        s.walk(reader, "", false)?;
        Ok(s)
    }

    fn walk(&mut self, reader: Box<dyn ReadSeek>, prefix: &str, nested: bool) -> Result<()> {
        let mut zip = zip::ZipArchive::new(reader)?;
        let me = self.archives.len();
        self.archives.push(None);
        if zip.has_duplicate_names() {
            // The zip library keeps one entry per name. A lost slice still shows: the series
            // reads as unevenly spaced.
            self.report.skipped.push(Skipped {
                name: String::new(),
                reason: "entries with the same name; one of each kept",
            });
        }
        for i in 0..zip.len() {
            let entry = zip.by_index_raw(i)?;
            let name = format!("{prefix}{}", decode_name(entry.name_raw()));
            if entry.encrypted() {
                return Err(ZipError::Encrypted);
            }
            let skip = |s: &mut Self, reason| {
                s.report.skipped.push(Skipped {
                    name: name.clone(),
                    reason,
                })
            };
            let rel = match relative_path(&name) {
                Ok(rel) => rel,
                Err(reason) => {
                    skip(self, reason);
                    continue;
                }
            };
            if junk(&rel) {
                self.report.litter += 1;
                continue;
            }
            if entry.is_symlink() {
                skip(self, "symbolic link");
                continue;
            }
            if entry.is_dir() {
                continue;
            }
            drop(entry);
            self.report.files += 1;
            if self.report.files > self.limits.max_files {
                return Err(ZipError::TooManyFiles(self.limits.max_files));
            }
            let mut entry = zip.by_index(i)?;
            // Counted on what actually comes out, not on the sizes the headers claim.
            let room = self.limits.max_total - self.report.bytes;
            let by_ratio = ratio_cap(entry.compressed_size(), &self.limits);
            let cap = room.min(by_ratio);
            let bytes = read_capped(&mut entry, cap)?;
            drop(entry);
            if bytes.len() as u64 > cap {
                return Err(if cap == room {
                    ZipError::TooLarge(self.limits.max_total)
                } else {
                    ZipError::Ratio {
                        name,
                        ratio: self.limits.max_ratio,
                    }
                });
            }
            self.report.bytes += bytes.len() as u64;
            if bytes.starts_with(b"PK\x03\x04") {
                if nested {
                    skip(self, "zip nested more than one level, left packed");
                    continue;
                }
                // The inner zip is read from memory; it stays counted in `bytes`.
                let inner = format!("{name}/");
                self.walk(Box::new(Cursor::new(bytes)), &inner, true)?;
                continue;
            }
            if is_dicom(&bytes) {
                self.files.push(FileRef {
                    name,
                    loc: Loc::Entry {
                        archive: me,
                        index: i,
                    },
                });
            }
        }
        self.archives[me] = Some(Mutex::new(zip));
        Ok(())
    }
}

impl Source for ZipSource {
    fn files(&self) -> &[FileRef] {
        &self.files
    }

    fn read(&self, file: &FileRef) -> std::io::Result<Vec<u8>> {
        let Loc::Entry { archive, index } = file.loc else {
            return Err(std::io::Error::other("not an entry of this zip"));
        };
        let mut zip = self
            .archives
            .get(archive)
            .and_then(|a| a.as_ref())
            .ok_or_else(|| std::io::Error::other("no such archive"))?
            .lock()
            .map_err(|_| std::io::Error::other("zip reader poisoned"))?;
        let mut entry = zip.by_index(index).map_err(std::io::Error::other)?;
        let cap = ratio_cap(entry.compressed_size(), &self.limits);
        let bytes = read_capped(&mut entry, cap)?;
        if bytes.len() as u64 > cap {
            return Err(std::io::Error::other(format!(
                "{} inflates past its limit",
                file.name
            )));
        }
        Ok(bytes)
    }
}

/// Whether a zip holds DICOM images, looking only at the first bytes of its first `probe` files.
pub fn holds_dicom(zip: &Path, probe: usize) -> bool {
    let Ok(file) = std::fs::File::open(zip) else {
        return false;
    };
    let Ok(mut archive) = zip::ZipArchive::new(std::io::BufReader::new(file)) else {
        return false;
    };
    let mut seen = 0;
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };
        if entry.encrypted() {
            // Says so when it is opened, rather than passing for something else.
            return true;
        }
        let name = decode_name(entry.name_raw());
        if !entry.is_file() || junk(Path::new(&name)) || entry.size() < 132 {
            continue;
        }
        let mut head = [0u8; 132];
        if entry.read_exact(&mut head).is_ok() && is_dicom(&head) {
            return true;
        }
        seen += 1;
        if seen >= probe {
            break;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn dicom(tag: &[u8]) -> Vec<u8> {
        let mut v = vec![0u8; 128];
        v.extend_from_slice(b"DICM");
        v.extend_from_slice(tag);
        v
    }

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            if let Some(target) = name.strip_prefix("link:") {
                w.add_symlink(target, "/etc/passwd", opts).unwrap();
            } else {
                w.start_file(*name, opts).unwrap();
                w.write_all(data).unwrap();
            }
        }
        w.finish().unwrap().into_inner()
    }

    fn open(bytes: &[u8], limits: &Limits) -> Result<ZipSource> {
        ZipSource::from_bytes(bytes.to_vec(), limits)
    }

    fn names(s: &ZipSource) -> Vec<&str> {
        s.files().iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn reads_dicom_in_place_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("upload.zip");
        std::fs::write(
            &path,
            zip_of(&[
                ("study/a", &dicom(b"one")),
                ("study/b.dcm", &dicom(b"two")),
                ("readme.txt", b"hello"),
            ]),
        )
        .unwrap();
        let s = ZipSource::open(&path, &Limits::default()).unwrap();
        assert_eq!(names(&s), ["study/a", "study/b.dcm"]);
        assert_eq!(s.read(&s.files()[1]).unwrap(), dicom(b"two"));
        assert_eq!(s.report.files, 3);
        // Nothing was written beside the archive.
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1);
    }

    #[test]
    fn refuses_paths_out_of_the_folder_and_links() {
        let d = dicom(b"x");
        let bytes = zip_of(&[
            ("../evil", &d),
            ("/etc/evil", &d),
            ("ok/../../evil", &d),
            ("link:ok/link", b""),
            ("ok/fine", &d),
        ]);
        let s = open(&bytes, &Limits::default()).unwrap();
        assert_eq!(names(&s), ["ok/fine"]);
        let reasons: Vec<_> = s
            .report
            .skipped
            .iter()
            .map(|s| (s.name.as_str(), s.reason))
            .collect();
        assert_eq!(
            reasons,
            [
                ("../evil", "path leaves the folder"),
                ("/etc/evil", "path leaves the folder"),
                ("ok/../../evil", "path leaves the folder"),
                ("ok/link", "symbolic link"),
            ]
        );
    }

    /// Replaces every `from` in the archive (local and central headers) with `to`, same length.
    fn patch(bytes: &mut [u8], from: &[u8], to: &[u8]) {
        assert_eq!(from.len(), to.len());
        let mut hits = 0;
        let mut i = 0;
        while i + from.len() <= bytes.len() {
            if &bytes[i..i + from.len()] == from {
                bytes[i..i + from.len()].copy_from_slice(to);
                hits += 1;
            }
            i += 1;
        }
        assert!(hits >= 2, "{hits}: a name sits in the local and the central header");
    }

    #[test]
    fn skips_litter_and_says_when_names_clash() {
        let mut bytes = zip_of(&[
            ("__MACOSX/._a.dcm", &dicom(b"j")),
            ("s/.DS_Store", b"junk"),
            ("s/a.dcm", &dicom(b"first")),
            ("s/b.dcm", &dicom(b"second")),
        ]);
        patch(&mut bytes, b"s/b.dcm", b"s/a.dcm");
        let s = open(&bytes, &Limits::default()).unwrap();
        assert_eq!(s.report.litter, 2);
        let reasons: Vec<_> = s.report.skipped.iter().map(|s| s.reason).collect();
        assert_eq!(reasons, ["entries with the same name; one of each kept"]);
    }

    #[test]
    fn reads_one_nested_zip_and_no_deeper() {
        let deepest = zip_of(&[("c.dcm", &dicom(b"c"))]);
        let inner = zip_of(&[("b.dcm", &dicom(b"b")), ("deeper.zip", &deepest)]);
        let bytes = zip_of(&[("a.dcm", &dicom(b"a")), ("inner.zip", &inner)]);
        let s = open(&bytes, &Limits::default()).unwrap();
        assert_eq!(names(&s), ["a.dcm", "inner.zip/b.dcm"]);
        assert_eq!(s.read(&s.files()[1]).unwrap(), dicom(b"b"));
        assert_eq!(s.report.skipped[0].name, "inner.zip/deeper.zip");
        assert_eq!(
            s.report.skipped[0].reason,
            "zip nested more than one level, left packed"
        );
    }

    #[test]
    fn stops_zip_bombs_by_what_comes_out() {
        let zeros = vec![0u8; 4 << 20];
        let r = open(&zip_of(&[("bomb.bin", &zeros)]), &Limits::default());
        assert!(matches!(r, Err(ZipError::Ratio { .. })), "{:?}", r.err());

        let limits = Limits {
            max_total: 10,
            ..Limits::default()
        };
        let r = open(&zip_of(&[("a", b"123456"), ("b", b"123456")]), &limits);
        assert!(matches!(r, Err(ZipError::TooLarge(10))), "{:?}", r.err());

        let limits = Limits {
            max_files: 1,
            ..Limits::default()
        };
        let r = open(&zip_of(&[("a", b"1"), ("b", b"2")]), &limits);
        assert!(matches!(r, Err(ZipError::TooManyFiles(1))), "{:?}", r.err());
    }

    #[test]
    fn reads_gbk_names() {
        // 报告.dcm in GBK, with no UTF-8 flag: what a Windows archiver in China writes.
        let gbk = [0xB1, 0xA8, 0xB8, 0xE6];
        let mut bytes = zip_of(&[("XXXX.dcm", &dicom(b"r"))]);
        patch(&mut bytes, b"XXXX.dcm", &[&gbk[..], b".dcm"].concat());
        let s = open(&bytes, &Limits::default()).unwrap();
        assert_eq!(names(&s), ["报告.dcm"]);
        assert_eq!(decode_name(&[0xFF, 0xFE, b'a']), "%FF%FEa");
    }

    #[test]
    fn refuses_password_protected_archives() {
        let mut bytes = zip_of(&[("a.dcm", b"secret")]);
        // Set bit 0 of the general purpose flags in both headers.
        bytes[6] |= 1;
        let central = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[central + 8] |= 1;
        let r = open(&bytes, &Limits::default());
        assert!(matches!(r, Err(ZipError::Encrypted)), "{:?}", r.err());
    }

    #[test]
    fn garbage_is_not_a_zip() {
        assert!(matches!(
            open(b"not a zip at all", &Limits::default()),
            Err(ZipError::Zip(_))
        ));
    }

    #[test]
    fn tells_a_study_from_another_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let mut d = dicom(&[0u8; 64]);
        d.truncate(196);
        let study = tmp.path().join("study.zip");
        std::fs::write(
            &study,
            zip_of(&[("__MACOSX/._x", &d), ("readme.txt", &[b'x'; 200]), ("s/1", &d)]),
        )
        .unwrap();
        assert!(holds_dicom(&study, 20));
        let other = tmp.path().join("other.zip");
        std::fs::write(&other, zip_of(&[("a.txt", &[b'x'; 300])])).unwrap();
        assert!(!holds_dicom(&other, 20));
        std::fs::write(tmp.path().join("not.zip"), b"nope").unwrap();
        assert!(!holds_dicom(&tmp.path().join("not.zip"), 20));
    }
}
