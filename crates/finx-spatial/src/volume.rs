//! What the core knows about a volume (spatial-design §6.1). Nothing here is about one industry:
//! what the values mean is said by the reader, industry fields go in `meta` under the pack's prefix.

use serde::{Deserialize, Serialize};

/// Voxel values are stored as `i16` for now: CT in HU fits. Wider types come with the industrial
/// pack, as new variants.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DType {
    I16,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ValueMeaning {
    /// A physical quantity with one calibration, as HU for CT. The values are already rescaled.
    Calibrated { unit: String },
    /// No common calibration, as the grey levels of industrial CT.
    Raw,
}

/// The value of voxels with no data, as outside a CT's circular field of view (§7.2). Statistics,
/// thresholds and the pyramid leave them out.
pub const NODATA: i16 = i16::MIN;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VolumeInfo {
    /// Voxels along i, j, k.
    pub dims: [u32; 3],
    /// mm along i, j, k.
    pub spacing: [f64; 3],
    /// The first voxel's centre, in patient coordinates LPS (VD-27), mm.
    pub origin: [f64; 3],
    /// The directions of i, j and k in patient coordinates.
    pub direction: [[f64; 3]; 3],
    pub dtype: DType,
    pub value: ValueMeaning,
    /// Some voxels hold [`NODATA`].
    pub has_nodata: bool,
    /// The pack's fields, keys prefixed with its id, as `medical.kernel`.
    #[serde(default)]
    pub meta: serde_json::Map<String, serde_json::Value>,
}

impl VolumeInfo {
    pub fn voxels(&self) -> usize {
        self.dims.iter().map(|d| *d as usize).product()
    }
}

/// The patient side a direction points to in LPS (VD-27), by its largest component: `R`/`L`,
/// `A`/`P`, `I`/`S`.
pub fn side_of(v: [f64; 3]) -> char {
    let axis = (0..3).max_by(|a, b| v[*a].abs().total_cmp(&v[*b].abs())).expect("three axes");
    let sides = [('R', 'L'), ('A', 'P'), ('I', 'S')][axis];
    if v[axis] > 0.0 { sides.1 } else { sides.0 }
}

/// The side opposite.
pub fn opposite(side: char) -> char {
    match side {
        'R' => 'L',
        'L' => 'R',
        'A' => 'P',
        'P' => 'A',
        'I' => 'S',
        _ => 'I',
    }
}

/// Where a reader puts a volume: told the volume first, then given its k slices in order, each
/// `dims[0] * dims[1]` values with i fastest.
pub trait BrickSink {
    fn begin(&mut self, info: &VolumeInfo) -> std::io::Result<()>;
    fn slice(&mut self, values: &[i16]) -> std::io::Result<()>;
}

/// A whole volume in memory: for small data and tests. Large data goes to a
/// [`crate::brick::BrickWriter`].
#[derive(Debug, Default)]
pub struct Dense {
    pub info: Option<VolumeInfo>,
    pub values: Vec<i16>,
}

impl BrickSink for Dense {
    fn begin(&mut self, info: &VolumeInfo) -> std::io::Result<()> {
        self.values.reserve(info.voxels());
        self.info = Some(info.clone());
        Ok(())
    }

    fn slice(&mut self, values: &[i16]) -> std::io::Result<()> {
        self.values.extend_from_slice(values);
        Ok(())
    }
}

/// A volume in memory, values i fastest: what the algorithms and recipes work on.
#[derive(Clone, Debug)]
pub struct Volume {
    pub info: VolumeInfo,
    pub values: Vec<i16>,
}

impl Volume {
    /// Level 0 of a brick cache, read slice by slice.
    pub fn from_store(store: &crate::brick::BrickStore) -> std::io::Result<Self> {
        let info = store.info().clone();
        let mut values = Vec::with_capacity(info.voxels());
        for k in 0..info.dims[2] {
            values.extend(store.slice_k(0, k)?);
        }
        Ok(Self { info, values })
    }

    /// The patient position (LPS, mm) of voxel `ijk`, fractional indices allowed.
    pub fn to_patient(&self, ijk: [f64; 3]) -> [f64; 3] {
        to_patient(&self.info, ijk)
    }

    /// The voxel indices (fractional) of a patient position.
    pub fn to_index(&self, p: [f64; 3]) -> [f64; 3] {
        let i = &self.info;
        let d = [p[0] - i.origin[0], p[1] - i.origin[1], p[2] - i.origin[2]];
        // The directions are orthonormal: project on each.
        [0, 1, 2].map(|a| {
            (d[0] * i.direction[a][0] + d[1] * i.direction[a][1] + d[2] * i.direction[a][2]) / i.spacing[a]
        })
    }
}

pub fn to_patient(i: &VolumeInfo, ijk: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|c| i.origin[c] + (0..3).map(|a| i.direction[a][c] * i.spacing[a] * ijk[a]).sum::<f64>())
}
