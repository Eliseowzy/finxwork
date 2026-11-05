//! Faces for BetterOffice from the machine itself: the app ships no fonts at all.
//!
//! A family resolves, in order, to: the face of that name among Office's own fonts when Microsoft
//! Office is installed (read at run time, never shipped), then the user's, the machine's and
//! macOS's fonts; for a family the machine lacks, a metric-close macOS stand-in (Calibri → Helvetica
//! Neue, Cambria → Georgia, ...), PingFang SC for a CJK family, and last Helvetica Neue.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use betteroffice_pptx::fonts::{
    FontError, FontFaceHandle, FontPack, FontProvider, LastResortOffice,
};

const OFFICE_APPS: [&str; 3] = ["PowerPoint", "Word", "Excel"];
const ASSETS: &str = "/System/Library/AssetsV2";
/// PingFang SC's faces in PingFang.ttc.
const PINGFANG_REGULAR: usize = 3;
const PINGFANG_SEMIBOLD: usize = 11;
/// Families the machine may lack, and the macOS family drawn instead.
const STAND_INS: [(&str, &str); 14] = [
    ("calibri", "Helvetica Neue"),
    ("calibri light", "Helvetica Neue"),
    ("aptos", "Helvetica Neue"),
    ("segoe ui", "Helvetica Neue"),
    ("carlito", "Helvetica Neue"),
    ("candara", "Helvetica Neue"),
    ("corbel", "Helvetica Neue"),
    ("tahoma", "Verdana"),
    ("cambria", "Georgia"),
    ("constantia", "Georgia"),
    ("caladea", "Georgia"),
    ("consolas", "Menlo"),
    ("liberation sans", "Arial"),
    ("liberation serif", "Times New Roman"),
];
const LAST_RESORT: [&str; 3] = ["Helvetica Neue", "Helvetica", "Arial"];

pub struct SystemFonts;

impl SystemFonts {
    pub fn new() -> Result<Arc<Self>, FontError> {
        Ok(Arc::new(Self))
    }
}

impl FontProvider for SystemFonts {
    fn resolve_family(&self, family: &str, bold: bool, italic: bool) -> Option<FontFaceHandle> {
        office_face(family, bold)
            .or_else(|| installed_face(family, bold, italic))
            .or_else(|| {
                let lower = family.trim().to_lowercase();
                STAND_INS
                    .iter()
                    .find(|(name, _)| *name == lower)
                    .and_then(|(_, stand_in)| installed_face(stand_in, bold, italic))
            })
            .or_else(|| {
                is_cjk_family(family)
                    .then(|| pingfang(family, bold))
                    .flatten()
            })
    }

    fn resolve_script_fallback(
        &self,
        script: &str,
        bold: bool,
        _italic: bool,
    ) -> Option<FontFaceHandle> {
        if script.starts_with("cjk") {
            return pingfang("PingFang SC", bold);
        }
        None
    }

    fn resolve_glyph_fallback(
        &self,
        _family: &str,
        bold: bool,
        italic: bool,
        _office: LastResortOffice,
    ) -> Option<FontFaceHandle> {
        installed_face("Arial Unicode MS", bold, italic)
    }

    fn resolve_last_resort(
        &self,
        family: &str,
        bold: bool,
        italic: bool,
        _office: LastResortOffice,
    ) -> FontFaceHandle {
        LAST_RESORT
            .iter()
            .find_map(|name| installed_face(name, bold, italic))
            .unwrap_or_else(|| {
                file_face(
                    family,
                    bold,
                    italic,
                    PathBuf::from("/System/Library/Fonts/Helvetica.ttc"),
                    0,
                )
            })
    }

    /// `None`: with packs named, the font manager drops every face outside them, and the
    /// machine's faces would draw as boxes.
    fn bundled_packs(&self) -> Option<Vec<FontPack>> {
        None
    }
}

/// One face of a font file, as its name and OS/2 tables describe it.
#[derive(Clone, Debug)]
struct Installed {
    path: PathBuf,
    index: usize,
    bold: bool,
    italic: bool,
}

/// The face for `family` among the installed fonts: the asked-for style, else the regular
/// weight of the same slant (the rasterizer emboldens it), else any face of the family.
fn installed_face(family: &str, bold: bool, italic: bool) -> Option<FontFaceHandle> {
    let faces = installed().get(&family.trim().to_lowercase())?;
    let pick = faces
        .iter()
        .find(|f| f.bold == bold && f.italic == italic)
        .or_else(|| faces.iter().find(|f| !f.bold && f.italic == italic))
        .or_else(|| faces.iter().find(|f| !f.bold && !f.italic))
        .or_else(|| faces.first())?;
    Some(file_face(
        family,
        bold,
        italic,
        pick.path.clone(),
        pick.index,
    ))
}

/// Every installed face by lower-cased family name, built once. Only each file's table
/// directory and its name and OS/2 tables are read, not the whole font.
fn installed() -> &'static HashMap<String, Vec<Installed>> {
    static INDEX: OnceLock<HashMap<String, Vec<Installed>>> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut dirs: Vec<PathBuf> = OFFICE_APPS
            .iter()
            .map(|app| {
                PathBuf::from(format!(
                    "/Applications/Microsoft {app}.app/Contents/Resources/Fonts"
                ))
            })
            .collect();
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(Path::new(&home).join("Library/Fonts"));
        }
        dirs.extend(
            [
                "/Library/Fonts",
                "/System/Library/Fonts/Supplemental",
                "/System/Library/Fonts",
            ]
            .map(PathBuf::from),
        );
        let mut index: HashMap<String, Vec<Installed>> = HashMap::new();
        for dir in dirs {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            files.sort();
            for path in files {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(str::to_lowercase);
                if !matches!(ext.as_deref(), Some("ttf" | "otf" | "ttc")) {
                    continue;
                }
                let Some(faces) = describe(&path) else {
                    continue;
                };
                for (i, (names, bold, italic)) in faces.into_iter().enumerate() {
                    for name in names {
                        let list = index.entry(name).or_default();
                        // The first directory to have a style wins (Office before macOS).
                        if !list.iter().any(|f| f.bold == bold && f.italic == italic) {
                            list.push(Installed {
                                path: path.clone(),
                                index: i,
                                bold,
                                italic,
                            });
                        }
                    }
                }
            }
        }
        index
    })
}

/// Each face of a font file: its family names (every language), bold and italic.
fn describe(path: &Path) -> Option<Vec<(Vec<String>, bool, bool)>> {
    let mut file = File::open(path).ok()?;
    let mut read_at = |at: u64, len: usize| -> Option<Vec<u8>> {
        file.seek(SeekFrom::Start(at)).ok()?;
        let mut buf = vec![0; len];
        file.read_exact(&mut buf).ok()?;
        Some(buf)
    };
    let head = read_at(0, 12)?;
    let offsets: Vec<u64> = if &head[0..4] == b"ttcf" {
        let count = be32(&head, 8)? as usize;
        let table = read_at(12, 4 * count.min(256))?;
        (0..count.min(256))
            .filter_map(|i| be32(&table, 4 * i).map(u64::from))
            .collect()
    } else {
        vec![0]
    };
    let mut faces = Vec::new();
    for offset in offsets {
        let dir = read_at(offset, 12)?;
        let tables = be16(&dir, 4)? as usize;
        let records = read_at(offset + 12, 16 * tables)?;
        let mut name = None;
        let mut os2 = None;
        for r in records.as_chunks::<16>().0 {
            let (at, len) = (u64::from(be32(r, 8)?), be32(r, 12)? as usize);
            match &r[0..4] {
                b"name" => name = Some((at, len)),
                b"OS/2" => os2 = Some((at, len.min(64))),
                _ => {}
            }
        }
        let names = name
            .and_then(|(at, len)| read_at(at, len))
            .map(|t| family_names(&t))
            .unwrap_or_default();
        let (bold, italic) = os2
            .and_then(|(at, len)| read_at(at, len))
            .and_then(|t| Some((be16(&t, 4)?, be16(&t, 62)?)))
            .map(|(weight, selection)| {
                (
                    weight >= 600 || selection & 0x20 != 0,
                    selection & 0x01 != 0,
                )
            })
            .unwrap_or((false, false));
        faces.push((names, bold, italic));
    }
    Some(faces)
}

/// The family names (IDs 1 and 16) of a `name` table, lower-cased, in every language.
fn family_names(table: &[u8]) -> Vec<String> {
    let mut names = Vec::new();
    let (Some(count), Some(strings)) = (be16(table, 2), be16(table, 4)) else {
        return names;
    };
    for i in 0..count as usize {
        let r = 6 + 12 * i;
        let (Some(platform), Some(id), Some(len), Some(at)) = (
            be16(table, r),
            be16(table, r + 6),
            be16(table, r + 8),
            be16(table, r + 10),
        ) else {
            break;
        };
        if id != 1 && id != 16 {
            continue;
        }
        let start = strings as usize + at as usize;
        let Some(bytes) = table.get(start..start + len as usize) else {
            continue;
        };
        let text = match platform {
            0 | 3 => String::from_utf16_lossy(
                &bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            ),
            1 => bytes.iter().map(|&b| b as char).collect(),
            _ => continue,
        };
        let text = text.trim().to_lowercase();
        if !text.is_empty() && !names.contains(&text) {
            names.push(text);
        }
    }
    names
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Office's file for a CJK family: its regular face and, if Office has one, its bold face.
fn office_files(family: &str) -> Option<(&'static str, Option<&'static str>)> {
    let lower = family.to_lowercase();
    let is = |names: &[&str]| names.iter().any(|n| lower.contains(n));
    if is(&["microsoft yahei", "微软雅黑"]) {
        Some(("msyh.ttf", Some("msyhbd.ttf")))
    } else if is(&["dengxian", "等线"]) {
        Some(("Deng.ttf", Some("Dengb.ttf")))
    } else if is(&["simhei", "黑体"]) {
        Some(("SimHei.ttf", None))
    } else if is(&["simsun", "宋体"]) {
        Some(("SimSun.ttf", None))
    } else {
        None
    }
}

fn office_face(family: &str, bold: bool) -> Option<FontFaceHandle> {
    let (regular, bold_file) = office_files(family)?;
    let file = if bold {
        bold_file.unwrap_or(regular)
    } else {
        regular
    };
    let path = OFFICE_APPS
        .iter()
        .map(|app| {
            PathBuf::from(format!(
                "/Applications/Microsoft {app}.app/Contents/Resources/Fonts/{file}"
            ))
        })
        .find(|path| path.exists())?;
    Some(file_face(
        family,
        bold && bold_file.is_some(),
        false,
        path,
        0,
    ))
}

fn pingfang(family: &str, bold: bool) -> Option<FontFaceHandle> {
    let path = pingfang_path()?.clone();
    let index = if bold {
        PINGFANG_SEMIBOLD
    } else {
        PINGFANG_REGULAR
    };
    Some(file_face(family, bold, false, path, index))
}

/// PingFang.ttc: a downloadable asset under a hashed directory of `AssetsV2`, or in
/// `/System/Library/Fonts` on older systems.
fn pingfang_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let legacy = PathBuf::from("/System/Library/Fonts/PingFang.ttc");
        if legacy.exists() {
            return Some(legacy);
        }
        let mut found: Vec<PathBuf> = std::fs::read_dir(ASSETS)
            .ok()?
            .flatten()
            .filter(|kind| {
                kind.file_name()
                    .to_string_lossy()
                    .starts_with("com_apple_MobileAsset_Font")
            })
            .flat_map(|kind| {
                std::fs::read_dir(kind.path())
                    .into_iter()
                    .flatten()
                    .flatten()
            })
            .map(|asset| asset.path().join("AssetData/PingFang.ttc"))
            .filter(|path| path.exists())
            .collect();
        // The newest asset catalog sorts last (Font7, Font8, ...).
        found.sort();
        found.pop()
    })
    .as_ref()
}

fn file_face(
    family: &str,
    bold: bool,
    italic: bool,
    path: PathBuf,
    index: usize,
) -> FontFaceHandle {
    FontFaceHandle::new(family, bold, italic, move || load_face(&path, index))
}

fn load_face(path: &Path, index: usize) -> Result<Vec<u8>, FontError> {
    let bytes = std::fs::read(path)
        .map_err(|e| FontError::InvalidFontOptions(format!("{}: {e}", path.display())))?;
    collection_face(&bytes, index).ok_or_else(|| {
        FontError::InvalidFontOptions(format!("{}: no face {index}", path.display()))
    })
}

fn is_cjk_family(family: &str) -> bool {
    let lower = family.to_lowercase();
    const NAMES: [&str; 8] = [
        "pingfang",
        "苹方",
        "思源",
        "source han",
        "noto sans sc",
        "noto sans cjk",
        "hiragino",
        "stheiti",
    ];
    NAMES.iter().any(|n| lower.contains(n))
        || family
            .chars()
            .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// Face `index` of a TrueType/OpenType collection as a standalone font; a plain font is its
/// own face 0.
pub(crate) fn collection_face(file: &[u8], index: usize) -> Option<Vec<u8>> {
    let u32_at = |at: usize| Some(u32::from_be_bytes(file.get(at..at + 4)?.try_into().ok()?));
    let u16_at = |at: usize| Some(u16::from_be_bytes(file.get(at..at + 2)?.try_into().ok()?));
    if file.get(0..4)? != b"ttcf" {
        return (index == 0).then(|| file.to_vec());
    }
    if index >= u32_at(8)? as usize {
        return None;
    }
    let offset = u32_at(12 + 4 * index)? as usize;
    let tables = u16_at(offset + 4)? as usize;
    let header_len = 12 + 16 * tables;
    let mut records = file.get(offset..offset + 12)?.to_vec();
    let mut data = Vec::new();
    for i in 0..tables {
        let record = offset + 12 + 16 * i;
        let (start, len) = (u32_at(record + 8)? as usize, u32_at(record + 12)? as usize);
        records.extend_from_slice(file.get(record..record + 8)?);
        records.extend_from_slice(&((header_len + data.len()) as u32).to_be_bytes());
        records.extend_from_slice(&(len as u32).to_be_bytes());
        data.extend_from_slice(file.get(start..start + len)?);
        data.resize(data.len().next_multiple_of(4), 0);
    }
    records.extend(data);
    Some(records)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A collection of two faces with one table each.
    fn collection() -> Vec<u8> {
        let face = |tag: &[u8; 4], table_at: u32| {
            let mut f = vec![0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
            f.extend_from_slice(tag);
            f.extend_from_slice(&[0; 4]);
            f.extend_from_slice(&table_at.to_be_bytes());
            f.extend_from_slice(&3u32.to_be_bytes());
            f
        };
        let mut file = b"ttcf".to_vec();
        file.extend_from_slice(&[0, 1, 0, 0, 0, 0, 0, 2]);
        file.extend_from_slice(&20u32.to_be_bytes());
        file.extend_from_slice(&48u32.to_be_bytes());
        file.extend(face(b"aaaa", 76));
        file.extend(face(b"bbbb", 80));
        file.extend_from_slice(b"AAA\0BBB\0");
        file
    }

    #[test]
    fn a_collection_face_stands_alone() {
        let face = collection_face(&collection(), 1).unwrap();
        assert_eq!(&face[12..16], b"bbbb");
        assert_eq!(u32::from_be_bytes(face[20..24].try_into().unwrap()), 28);
        assert_eq!(&face[28..31], b"BBB");
        assert_eq!(face.len(), 32);
        assert!(collection_face(&collection(), 2).is_none());
    }

    #[test]
    fn a_plain_font_is_its_own_face() {
        assert_eq!(
            collection_face(b"\0\x01\0\0rest", 0).unwrap(),
            b"\0\x01\0\0rest"
        );
        assert!(collection_face(b"\0\x01\0\0rest", 1).is_none());
    }

    #[test]
    fn office_families_map_to_their_files() {
        assert_eq!(
            office_files("微软雅黑"),
            Some(("msyh.ttf", Some("msyhbd.ttf")))
        );
        assert_eq!(
            office_files("Microsoft YaHei UI"),
            Some(("msyh.ttf", Some("msyhbd.ttf")))
        );
        assert_eq!(
            office_files("DengXian"),
            Some(("Deng.ttf", Some("Dengb.ttf")))
        );
        assert_eq!(office_files("宋体"), Some(("SimSun.ttf", None)));
        assert_eq!(office_files("Arial"), None);
    }

    #[test]
    fn cjk_families_are_told_from_latin_ones() {
        assert!(is_cjk_family("PingFang SC"));
        assert!(is_cjk_family("华文楷体"));
        assert!(!is_cjk_family("Calibri"));
    }

    #[test]
    fn office_and_macos_families_are_found_by_name() {
        assert!(installed_face("Arial", false, false).is_some());
        assert!(installed_face("Times New Roman", true, true).is_some());
        let provider = SystemFonts::new().unwrap();
        // A family the machine lacks still draws, in its stand-in or the last resort.
        assert!(provider.resolve_family("Cambria", false, false).is_some());
        let _ = provider.resolve_last_resort("Nope", false, false, LastResortOffice::default());
    }

    #[test]
    fn the_provider_keeps_every_face() {
        assert!(SystemFonts::new().unwrap().bundled_packs().is_none());
    }
}
