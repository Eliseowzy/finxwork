//! Faces for BetterOffice from the machine itself, so the app ships no CJK fonts.
//!
//! A family resolves, in order, to: Office's own CJK faces when Microsoft Office is installed
//! (read at run time, never shipped); a Latin family macOS keeps in `Supplemental`; PingFang SC
//! for any other CJK family; BetterOffice's bundled Latin pack.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use betteroffice_pptx::fonts::{
    BundledFontOptions, BundledFonts, FontError, FontFaceHandle, FontPack, FontProvider,
    LastResortOffice,
};

const OFFICE_APPS: [&str; 3] = ["PowerPoint", "Word", "Excel"];
const SUPPLEMENTAL: &str = "/System/Library/Fonts/Supplemental";
const ASSETS: &str = "/System/Library/AssetsV2";
/// PingFang SC's faces in PingFang.ttc.
const PINGFANG_REGULAR: usize = 3;
const PINGFANG_SEMIBOLD: usize = 11;

pub struct SystemFonts {
    latin: BundledFonts,
}

impl SystemFonts {
    pub fn new() -> Result<Arc<Self>, FontError> {
        let latin = BundledFonts::new(BundledFontOptions {
            packs: vec![FontPack::Latin],
            base_url: None,
        })?;
        Ok(Arc::new(Self { latin }))
    }
}

impl FontProvider for SystemFonts {
    fn resolve_family(&self, family: &str, bold: bool, italic: bool) -> Option<FontFaceHandle> {
        office_face(family, bold)
            .or_else(|| supplemental_face(family, bold, italic))
            .or_else(|| {
                is_cjk_family(family)
                    .then(|| pingfang(family, bold))
                    .flatten()
            })
            .or_else(|| self.latin.resolve_family(family, bold, italic))
    }

    fn resolve_script_fallback(
        &self,
        script: &str,
        bold: bool,
        italic: bool,
    ) -> Option<FontFaceHandle> {
        if script.starts_with("cjk")
            && let Some(face) = pingfang("PingFang SC", bold)
        {
            return Some(face);
        }
        self.latin.resolve_script_fallback(script, bold, italic)
    }

    fn resolve_glyph_fallback(
        &self,
        family: &str,
        bold: bool,
        italic: bool,
        office: LastResortOffice,
    ) -> Option<FontFaceHandle> {
        self.latin
            .resolve_glyph_fallback(family, bold, italic, office)
    }

    fn resolve_last_resort(
        &self,
        family: &str,
        bold: bool,
        italic: bool,
        office: LastResortOffice,
    ) -> FontFaceHandle {
        self.latin.resolve_last_resort(family, bold, italic, office)
    }

    /// `None`: with packs named, the font manager drops every face outside them, and the
    /// system's CJK faces would draw as boxes.
    fn bundled_packs(&self) -> Option<Vec<FontPack>> {
        None
    }
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

fn supplemental_face(family: &str, bold: bool, italic: bool) -> Option<FontFaceHandle> {
    let style = match (bold, italic) {
        (false, false) => "",
        (true, false) => " Bold",
        (false, true) => " Italic",
        (true, true) => " Bold Italic",
    };
    let path = PathBuf::from(format!("{SUPPLEMENTAL}/{family}{style}.ttf"));
    path.exists()
        .then(|| file_face(family, bold, italic, path, 0))
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
    fn the_provider_keeps_every_face() {
        assert!(SystemFonts::new().unwrap().bundled_packs().is_none());
    }
}
