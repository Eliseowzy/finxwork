//! DICOM as a file format (spatial-design §4.1): find DICOM files by their content, group them
//! into series, sort along the slice normal, check the spacing, rescale each image on its own and
//! tell padding outside the field of view. Files come from a [`Source`]: a folder, or a zip read
//! in place.
//!
//! Only the fields a volume needs are read; patient identity is never read (§3).

use crate::source::{FileRef, Folder, Source};
use crate::volume::{BrickSink, DType, Dense, NODATA, ValueMeaning, Volume, VolumeInfo};
use dicom_dictionary_std::tags;
use dicom_object::file::ReadPreamble;
use dicom_object::{DefaultDicomObject, OpenFileOptions};
use dicom_pixeldata::{ConvertOptions, ModalityLutOption, PixelDecoder};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum DicomError {
    #[error("{name}: {message}")]
    File { name: String, message: String },
    #[error("series {0} cannot be a volume: {1}")]
    NotAVolume(String, String),
}

type Result<T> = std::result::Result<T, DicomError>;

fn file_error(file: &FileRef, e: impl std::fmt::Display) -> DicomError {
    DicomError::File {
        name: file.name.clone(),
        message: e.to_string(),
    }
}

const MEDIA_DIRECTORY: &str = "1.2.840.10008.1.3.10";

pub use crate::source::is_dicom;

/// One image of a series, as its header has it.
#[derive(Clone, Debug)]
pub struct Slice {
    pub file: FileRef,
    /// SOPInstanceUID: part of the volume's identity.
    pub sop_uid: String,
    /// ImagePositionPatient: the first pixel's centre, in mm.
    pub position: Option<[f64; 3]>,
    pub instance: Option<i32>,
}

/// A series found in a source, before it is read.
#[derive(Clone, Debug)]
pub struct SeriesInfo {
    pub uid: String,
    pub number: Option<i32>,
    pub description: String,
    pub modality: String,
    pub image_type: Vec<String>,
    pub kernel: Option<String>,
    pub transfer_syntax: String,
    pub rows: u32,
    pub columns: u32,
    /// Row spacing, then column spacing (PixelSpacing), in mm.
    pub pixel_spacing: Option<[f64; 2]>,
    pub slice_thickness: Option<f64>,
    /// ImageOrientationPatient: the row direction, then the column direction.
    pub orientation: Option<[f64; 6]>,
    /// In order along the slice normal once [`scan`] has sorted them.
    pub slices: Vec<Slice>,
    /// Distance between neighbouring slices along the normal, when they are evenly spaced.
    pub spacing: Option<f64>,
    /// Why this series cannot be a volume; `None` when it can.
    pub unusable: Option<String>,
}

impl SeriesInfo {
    pub fn usable(&self) -> bool {
        self.unusable.is_none()
    }

    /// The volume's identity (§3): sha256 of the SeriesInstanceUID and every image's
    /// SOPInstanceUID, sorted. The same series from a zip, a folder or a moved copy is one document.
    pub fn identity(&self) -> String {
        let mut uids: Vec<&str> = self.slices.iter().map(|s| s.sop_uid.as_str()).collect();
        uids.sort_unstable();
        let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
        ctx.update(self.uid.as_bytes());
        for u in uids {
            ctx.update(b"\n");
            ctx.update(u.as_bytes());
        }
        crate::hex(ctx.finish().as_ref())
    }
}

fn text(obj: &DefaultDicomObject, tag: dicom_object::Tag) -> Option<String> {
    let e = obj.element_opt(tag).ok().flatten()?;
    let s = e.to_str().ok()?.trim().trim_end_matches('\0').to_string();
    (!s.is_empty()).then_some(s)
}

fn floats<const N: usize>(obj: &DefaultDicomObject, tag: dicom_object::Tag) -> Option<[f64; N]> {
    let e = obj.element_opt(tag).ok().flatten()?;
    let v = e.to_multi_float64().ok()?;
    v.try_into().ok()
}

fn float(obj: &DefaultDicomObject, tag: dicom_object::Tag) -> Option<f64> {
    obj.element_opt(tag).ok().flatten()?.to_float64().ok()
}

fn int(obj: &DefaultDicomObject, tag: dicom_object::Tag) -> Option<i32> {
    obj.element_opt(tag).ok().flatten()?.to_int::<i32>().ok()
}

fn parse(bytes: &[u8], header_only: bool) -> std::result::Result<DefaultDicomObject, dicom_object::ReadError> {
    let mut o = OpenFileOptions::new().read_preamble(ReadPreamble::Always);
    if header_only {
        o = o.read_until(tags::PIXEL_DATA);
    }
    o.from_reader(bytes)
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The slice normal of an orientation: row direction × column direction.
fn normal(o: [f64; 6]) -> [f64; 3] {
    cross([o[0], o[1], o[2]], [o[3], o[4], o[5]])
}

/// Every series under a folder (or one file).
pub fn scan_dir(root: &Path) -> Result<Vec<SeriesInfo>> {
    scan(&Folder::new(root))
}

/// Every series of a source, usable ones first, each sorted along its normal. Unreadable DICOM
/// files are reported as errors.
pub fn scan(source: &dyn Source) -> Result<Vec<SeriesInfo>> {
    let mut by_uid: BTreeMap<String, SeriesInfo> = BTreeMap::new();
    for file in source.files() {
        let bytes = source.read(file).map_err(|e| file_error(file, e))?;
        let obj = parse(&bytes, true).map_err(|e| file_error(file, e))?;
        // DICOMDIR is an index of the media, not an image.
        if obj
            .meta()
            .media_storage_sop_class_uid()
            .trim_end_matches('\0')
            == MEDIA_DIRECTORY
        {
            continue;
        }
        let uid = text(&obj, tags::SERIES_INSTANCE_UID).unwrap_or_default();
        let slice = Slice {
            file: file.clone(),
            sop_uid: text(&obj, tags::SOP_INSTANCE_UID)
                .unwrap_or_else(|| obj.meta().media_storage_sop_instance_uid().trim_end_matches('\0').to_string()),
            position: floats(&obj, tags::IMAGE_POSITION_PATIENT),
            instance: int(&obj, tags::INSTANCE_NUMBER),
        };
        let series = by_uid.entry(uid.clone()).or_insert_with(|| SeriesInfo {
            uid,
            number: int(&obj, tags::SERIES_NUMBER),
            description: text(&obj, tags::SERIES_DESCRIPTION).unwrap_or_default(),
            modality: text(&obj, tags::MODALITY).unwrap_or_default(),
            image_type: text(&obj, tags::IMAGE_TYPE)
                .map(|t| t.split('\\').map(|p| p.trim().to_string()).collect())
                .unwrap_or_default(),
            kernel: text(&obj, tags::CONVOLUTION_KERNEL),
            transfer_syntax: obj
                .meta()
                .transfer_syntax()
                .trim_end_matches('\0')
                .to_string(),
            rows: int(&obj, tags::ROWS).unwrap_or(0) as u32,
            columns: int(&obj, tags::COLUMNS).unwrap_or(0) as u32,
            pixel_spacing: floats(&obj, tags::PIXEL_SPACING),
            slice_thickness: float(&obj, tags::SLICE_THICKNESS),
            orientation: floats(&obj, tags::IMAGE_ORIENTATION_PATIENT),
            slices: Vec::new(),
            spacing: None,
            unusable: None,
        });
        if series.rows != int(&obj, tags::ROWS).unwrap_or(0) as u32
            || series.columns != int(&obj, tags::COLUMNS).unwrap_or(0) as u32
        {
            series
                .unusable
                .get_or_insert_with(|| "images of different sizes".into());
        }
        series.slices.push(slice);
    }
    let mut out: Vec<SeriesInfo> = by_uid.into_values().map(finish).collect();
    out.sort_by_key(|s| (!s.usable(), s.number.unwrap_or(i32::MAX)));
    Ok(out)
}

/// Sorts a series along its normal, measures its spacing and decides whether it is a volume.
fn finish(mut s: SeriesInfo) -> SeriesInfo {
    let why = |s: &SeriesInfo| -> Option<String> {
        let kind = s
            .image_type
            .iter()
            .find(|t| matches!(t.as_str(), "LOCALIZER" | "SECONDARY" | "SCREEN SAVE"));
        if let Some(kind) = kind {
            return Some(format!("ImageType {kind}"));
        }
        if s.slices.len() < 3 {
            return Some(format!("{} image(s)", s.slices.len()));
        }
        if s.orientation.is_none()
            || s.pixel_spacing.is_none()
            || s.slices.iter().any(|x| x.position.is_none())
        {
            return Some("no position, orientation or pixel spacing".into());
        }
        None
    };
    if let Some(reason) = s.unusable.clone().or_else(|| why(&s)) {
        s.unusable = Some(reason);
        s.slices.sort_by_key(|x| x.instance.unwrap_or(i32::MAX));
        return s;
    }
    let n = normal(s.orientation.expect("checked"));
    let along = |x: &Slice| dot(x.position.expect("checked"), n);
    s.slices.sort_by(|a, b| along(a).total_cmp(&along(b)));
    let gaps: Vec<f64> = s
        .slices
        .windows(2)
        .map(|w| along(&w[1]) - along(&w[0]))
        .collect();
    let first = gaps[0];
    if gaps.iter().any(|g| *g < 1e-3) {
        s.unusable = Some("two images at the same position".into());
    } else if gaps
        .iter()
        .all(|g| (g - first).abs() <= 0.01 * first.max(0.01))
    {
        s.spacing = Some(gaps.iter().sum::<f64>() / gaps.len() as f64);
    } else {
        // Missing or uneven slices: said, not hidden.
        s.unusable = Some(format!(
            "uneven slice spacing ({:.3}..{:.3} mm)",
            gaps.iter().cloned().fold(f64::MAX, f64::min),
            gaps.iter().cloned().fold(0., f64::max)
        ));
    }
    s
}

/// Stored pixel values of one image, without rescaling: what a reference decoder gives too.
pub fn stored_values(source: &dyn Source, file: &FileRef) -> Result<Vec<i32>> {
    let bytes = source.read(file).map_err(|e| file_error(file, e))?;
    let obj = parse(&bytes, false).map_err(|e| file_error(file, e))?;
    let pixels = obj.decode_pixel_data().map_err(|e| file_error(file, e))?;
    let options = ConvertOptions::new().with_modality_lut(ModalityLutOption::None);
    pixels
        .to_vec_with_options::<i32>(&options)
        .map_err(|e| file_error(file, e))
}

/// A series read into memory: for tests and small data; see [`read_into`].
pub fn read(source: &dyn Source, series: &SeriesInfo) -> Result<Volume> {
    let mut dense = Dense::default();
    let info = read_into(source, series, &mut dense)?;
    Ok(Volume {
        info,
        values: dense.values,
    })
}

/// Reads a usable series slice by slice along the normal into `sink`, as modality values (HU for
/// CT) clamped to `i16`. Each image is rescaled with its own RescaleSlope and RescaleIntercept.
/// Stored values equal to PixelPaddingValue (or within PixelPaddingRangeLimit) are outside the
/// field of view and become [`NODATA`].
pub fn read_into(source: &dyn Source, series: &SeriesInfo, sink: &mut dyn BrickSink) -> Result<VolumeInfo> {
    if let Some(why) = &series.unusable {
        return Err(DicomError::NotAVolume(series.uid.clone(), why.clone()));
    }
    let o = series.orientation.expect("usable");
    let ps = series.pixel_spacing.expect("usable");
    let (cols, rows) = (series.columns, series.rows);
    let mut info = VolumeInfo {
        dims: [cols, rows, series.slices.len() as u32],
        // PixelSpacing is row spacing (between rows, along j) then column spacing (along i).
        spacing: [ps[1], ps[0], series.spacing.expect("usable")],
        origin: series.slices[0].position.expect("usable"),
        direction: [[o[0], o[1], o[2]], [o[3], o[4], o[5]], normal(o)],
        dtype: DType::I16,
        value: if series.modality == "CT" {
            ValueMeaning::Calibrated { unit: "HU".into() }
        } else {
            ValueMeaning::Raw
        },
        has_nodata: false,
        meta: series_meta(series),
    };
    let sink_error = |e: std::io::Error| DicomError::NotAVolume(series.uid.clone(), e.to_string());
    let mut images = Vec::with_capacity(series.slices.len());
    let mut nodata = false;
    // The padding of the first image decides `has_nodata`, which the sink must know before the
    // first slice; a later image's padding is NODATA all the same.
    for (n, slice) in series.slices.iter().enumerate() {
        let file = &slice.file;
        let bytes = source.read(file).map_err(|e| file_error(file, e))?;
        let obj = parse(&bytes, false).map_err(|e| file_error(file, e))?;
        drop(bytes);
        let padding = int(&obj, tags::PIXEL_PADDING_VALUE).map(|a| {
            let b = int(&obj, tags::PIXEL_PADDING_RANGE_LIMIT).unwrap_or(a);
            (a.min(b), a.max(b))
        });
        if n == 0 {
            nodata = padding.is_some();
            info.has_nodata = nodata;
            sink.begin(&info).map_err(sink_error)?;
        }
        let slope = float(&obj, tags::RESCALE_SLOPE).unwrap_or(1.0);
        let intercept = float(&obj, tags::RESCALE_INTERCEPT).unwrap_or(0.0);
        let pixels = obj.decode_pixel_data().map_err(|e| file_error(file, e))?;
        let stored: Vec<i32> = pixels
            .to_vec_with_options(&ConvertOptions::new().with_modality_lut(ModalityLutOption::None))
            .map_err(|e| file_error(file, e))?;
        if stored.len() != (cols * rows) as usize {
            return Err(file_error(
                file,
                format!("{} values for a {cols}x{rows} image", stored.len()),
            ));
        }
        images.clear();
        images.extend(stored.into_iter().map(|v| match padding {
            Some((lo, hi)) if nodata && (lo..=hi).contains(&v) => NODATA,
            _ => (v as f64 * slope + intercept)
                .round()
                .clamp(NODATA as f64 + 1.0, i16::MAX as f64) as i16,
        }));
        sink.slice(&images).map_err(sink_error)?;
    }
    Ok(info)
}

/// Fields of a series a viewer may show, under `dicom.`. No patient identity.
fn series_meta(s: &SeriesInfo) -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    m.insert("dicom.series_uid".into(), s.uid.clone().into());
    m.insert("dicom.identity".into(), s.identity().into());
    if let Some(n) = s.number {
        m.insert("dicom.series_number".into(), n.into());
    }
    m.insert("dicom.description".into(), s.description.clone().into());
    m.insert("dicom.modality".into(), s.modality.clone().into());
    if let Some(k) = &s.kernel {
        m.insert("dicom.kernel".into(), k.clone().into());
    }
    if let Some(t) = s.slice_thickness {
        m.insert("dicom.slice_thickness".into(), t.into());
    }
    m
}

/// A default series to open: the usable one with the smallest slice spacing, most images on a
/// tie. Preferences beyond that (a kernel, a description) belong to a skill (§2). Returns it with
/// the reason, in facts the model can retell.
pub fn pick(series: &[SeriesInfo]) -> Option<(&SeriesInfo, String)> {
    let best = series.iter().filter(|s| s.usable()).min_by(|a, b| {
        a.spacing
            .unwrap_or(f64::MAX)
            .total_cmp(&b.spacing.unwrap_or(f64::MAX))
            .then(b.slices.len().cmp(&a.slices.len()))
    })?;
    let mut why = format!(
        "thinnest usable series: {} slices {:.3} mm apart",
        best.slices.len(),
        best.spacing.unwrap_or(0.0)
    );
    let others: Vec<String> = series
        .iter()
        .filter(|s| s.uid != best.uid)
        .map(|s| match (&s.unusable, s.spacing) {
            (Some(w), _) => format!("#{} not a volume ({w})", s.number.unwrap_or(0)),
            (None, Some(sp)) => format!("#{} {:.3} mm apart", s.number.unwrap_or(0), sp),
            (None, None) => format!("#{}", s.number.unwrap_or(0)),
        })
        .collect();
    if !others.is_empty() {
        why.push_str("; others: ");
        why.push_str(&others.join(", "));
    }
    Some((best, why))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dicom_core::{DataElement, PrimitiveValue, VR};
    use dicom_object::{FileMetaTableBuilder, InMemDicomObject};
    use std::path::PathBuf;

    const CT: &str = "1.2.840.10008.5.1.4.1.1.2";

    struct Image<'a> {
        series: &'a str,
        number: i32,
        image_type: &'a str,
        z: f64,
        instance: i32,
        stored: [i16; 4],
        padding: Option<i16>,
        kernel: &'a str,
        description: &'a str,
    }

    /// A 2x2 CT image, explicit VR little endian, HU = stored - 1024.
    fn write(dir: &Path, name: &str, im: &Image) -> PathBuf {
        let mut obj = InMemDicomObject::new_empty();
        let mut put = |tag, vr, value: PrimitiveValue| obj.put(DataElement::new(tag, vr, value));
        put(tags::SOP_CLASS_UID, VR::UI, CT.into());
        put(
            tags::SOP_INSTANCE_UID,
            VR::UI,
            format!("1.2.3.{}.{}", im.number, im.instance).into(),
        );
        put(tags::IMAGE_TYPE, VR::CS, im.image_type.into());
        put(tags::MODALITY, VR::CS, "CT".into());
        put(tags::SERIES_INSTANCE_UID, VR::UI, im.series.into());
        put(tags::SERIES_NUMBER, VR::IS, im.number.to_string().into());
        put(
            tags::INSTANCE_NUMBER,
            VR::IS,
            im.instance.to_string().into(),
        );
        put(
            tags::IMAGE_POSITION_PATIENT,
            VR::DS,
            format!("-10\\-20\\{}", im.z).into(),
        );
        put(
            tags::IMAGE_ORIENTATION_PATIENT,
            VR::DS,
            "1\\0\\0\\0\\1\\0".into(),
        );
        put(tags::SAMPLES_PER_PIXEL, VR::US, PrimitiveValue::from(1u16));
        put(
            tags::PHOTOMETRIC_INTERPRETATION,
            VR::CS,
            "MONOCHROME2".into(),
        );
        put(tags::ROWS, VR::US, PrimitiveValue::from(2u16));
        put(tags::COLUMNS, VR::US, PrimitiveValue::from(2u16));
        put(tags::PIXEL_SPACING, VR::DS, "0.5\\0.7".into());
        put(tags::BITS_ALLOCATED, VR::US, PrimitiveValue::from(16u16));
        put(tags::BITS_STORED, VR::US, PrimitiveValue::from(16u16));
        put(tags::HIGH_BIT, VR::US, PrimitiveValue::from(15u16));
        put(
            tags::PIXEL_REPRESENTATION,
            VR::US,
            PrimitiveValue::from(1u16),
        );
        put(tags::RESCALE_INTERCEPT, VR::DS, "-1024".into());
        put(tags::RESCALE_SLOPE, VR::DS, "1".into());
        if let Some(p) = im.padding {
            put(tags::PIXEL_PADDING_VALUE, VR::SS, PrimitiveValue::from(p));
        }
        put(tags::CONVOLUTION_KERNEL, VR::SH, im.kernel.into());
        put(tags::SERIES_DESCRIPTION, VR::LO, im.description.into());
        let bytes: Vec<u8> = im.stored.iter().flat_map(|v| v.to_le_bytes()).collect();
        put(tags::PIXEL_DATA, VR::OW, PrimitiveValue::U8(bytes.into()));
        let file = obj
            .with_meta(FileMetaTableBuilder::new().transfer_syntax("1.2.840.10008.1.2.1"))
            .expect("meta");
        let path = dir.join(name);
        file.write_to_file(&path).expect("write");
        path
    }

    fn image(series: &str, number: i32, z: f64, instance: i32) -> Image<'_> {
        Image {
            series,
            number,
            image_type: "ORIGINAL\\PRIMARY\\AXIAL",
            z,
            instance,
            stored: [0, 1024, 2048, 24],
            padding: None,
            kernel: "STANDARD",
            description: "",
        }
    }

    #[test]
    fn finds_dicom_by_content_not_extension() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.dcm", &image("1.9", 2, 0.0, 1));
        write(dir.path(), "a.dcm.repeat_0", &image("1.9", 2, 1.25, 2));
        write(dir.path(), "no-extension", &image("1.9", 2, 2.5, 3));
        std::fs::write(dir.path().join("notes.dcm"), b"not dicom").unwrap();
        std::fs::create_dir(dir.path().join("__MACOSX")).unwrap();
        write(
            &dir.path().join("__MACOSX"),
            "._a.dcm",
            &image("1.9", 2, 9.0, 9),
        );
        let series = scan_dir(dir.path()).unwrap();
        assert_eq!(series.len(), 1);
        assert_eq!(
            series[0].slices.len(),
            3,
            "the .repeat_0 and extensionless files count, __MACOSX does not"
        );
    }

    #[test]
    fn sorts_along_the_normal_not_by_name_or_instance() {
        let dir = tempfile::tempdir().unwrap();
        // Names and instance numbers both disagree with the positions.
        write(dir.path(), "1", &image("1.9", 2, 2.5, 1));
        write(dir.path(), "2", &image("1.9", 2, 0.0, 3));
        write(dir.path(), "3", &image("1.9", 2, 1.25, 2));
        let s = &scan_dir(dir.path()).unwrap()[0];
        let zs: Vec<f64> = s.slices.iter().map(|x| x.position.unwrap()[2]).collect();
        assert_eq!(zs, [0.0, 1.25, 2.5]);
        assert_eq!(s.spacing, Some(1.25));
        let v = read(&Folder::new(dir.path()), s).unwrap();
        assert_eq!(v.info.dims, [2, 2, 3]);
        // PixelSpacing is "row spacing\column spacing": i (along a row) uses the second value.
        assert_eq!(v.info.spacing, [0.7, 0.5, 1.25]);
        assert_eq!(v.info.origin, [-10.0, -20.0, 0.0]);
        assert!(!v.info.has_nodata);
        assert_eq!(v.info.meta["dicom.series_number"], 2);
        assert_eq!(&v.values[..4], &[-1024, 0, 1024, -1000]);
    }

    #[test]
    fn says_why_a_series_is_not_a_volume() {
        let dir = tempfile::tempdir().unwrap();
        // A localizer.
        write(
            dir.path(),
            "top",
            &Image {
                image_type: "ORIGINAL\\PRIMARY\\LOCALIZER",
                ..image("1.1", 1, 0.0, 1)
            },
        );
        // A missing slice: 0, 1, 3.
        for (i, z) in [0.0, 1.0, 3.0].into_iter().enumerate() {
            write(
                dir.path(),
                &format!("gap{i}"),
                &image("1.2", 3, z, i as i32),
            );
        }
        // A good one, which comes first.
        for (i, z) in [0.0, 1.0, 2.0].into_iter().enumerate() {
            write(dir.path(), &format!("ok{i}"), &image("1.3", 4, z, i as i32));
        }
        let series = scan_dir(dir.path()).unwrap();
        assert_eq!(series[0].uid, "1.3");
        assert!(series[0].usable());
        let why = |uid: &str| {
            series
                .iter()
                .find(|s| s.uid == uid)
                .unwrap()
                .unusable
                .clone()
                .unwrap()
        };
        assert_eq!(why("1.1"), "ImageType LOCALIZER");
        assert!(
            why("1.2").starts_with("uneven slice spacing"),
            "{}",
            why("1.2")
        );
        assert!(matches!(
            read(&Folder::new(dir.path()), series.iter().find(|s| s.uid == "1.2").unwrap()),
            Err(DicomError::NotAVolume(..))
        ));
    }

    #[test]
    fn padding_outside_the_field_of_view_is_no_data() {
        let dir = tempfile::tempdir().unwrap();
        for (i, z) in [0.0, 1.0, 2.0].into_iter().enumerate() {
            // GE writes -2000 outside the circle; rescaled it would read as -3024 HU.
            let im = Image {
                stored: [-2000, 1024, -2000, 24],
                padding: Some(-2000),
                ..image("1.9", 2, z, i as i32)
            };
            write(dir.path(), &format!("{i}"), &im);
        }
        let v = read(&Folder::new(dir.path()), &scan_dir(dir.path()).unwrap()[0]).unwrap();
        assert!(v.info.has_nodata);
        assert_eq!(&v.values[..4], &[NODATA, 0, NODATA, -1000]);
    }

    #[test]
    fn picks_the_thinnest_and_hashes_the_identity() {
        let dir = tempfile::tempdir().unwrap();
        let put = |uid: &'static str, number, step: f64| {
            for i in 0..4 {
                write(dir.path(), &format!("{uid}-{i}"), &image(uid, number, i as f64 * step, i));
            }
        };
        put("1.1", 2, 5.0);
        put("1.3", 4, 1.25);
        let series = scan_dir(dir.path()).unwrap();
        let (best, why) = pick(&series).unwrap();
        assert_eq!(best.uid, "1.3");
        assert!(why.contains("#2 5.000 mm apart"), "{why}");
        assert_eq!(pick(&series[..1]).unwrap().0.uid, "1.1");
        // The identity does not depend on where the files are.
        let other = tempfile::tempdir().unwrap();
        for e in std::fs::read_dir(dir.path()).unwrap().flatten() {
            std::fs::copy(e.path(), other.path().join(format!("x{}", e.file_name().to_string_lossy()))).unwrap();
        }
        let again = scan_dir(other.path()).unwrap();
        let same = again.iter().find(|s| s.uid == "1.3").unwrap();
        assert_eq!(same.identity(), best.identity());
        assert_ne!(series[0].identity(), series[1].identity());
        assert_eq!(best.identity().len(), 64);
    }

    #[test]
    fn skips_dicomdir() {
        let dir = tempfile::tempdir().unwrap();
        for (i, z) in [0.0, 1.0, 2.0].into_iter().enumerate() {
            write(dir.path(), &format!("{i}"), &image("1.9", 2, z, i as i32));
        }
        let mut obj = InMemDicomObject::new_empty();
        obj.put(DataElement::new(
            tags::FILE_SET_ID,
            VR::CS,
            PrimitiveValue::from("STUDY"),
        ));
        obj.with_meta(
            FileMetaTableBuilder::new()
                .transfer_syntax("1.2.840.10008.1.2.1")
                .media_storage_sop_class_uid(MEDIA_DIRECTORY)
                .media_storage_sop_instance_uid("1.2.3.99"),
        )
        .unwrap()
        .write_to_file(dir.path().join("DICOMDIR"))
        .unwrap();
        let series = scan_dir(dir.path()).unwrap();
        assert_eq!(series.len(), 1, "{series:?}");
    }
}
