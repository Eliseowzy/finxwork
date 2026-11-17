//! The brick cache and its pyramid (spatial-design §6.2, VD-03, VV-03).
//!
//! A volume is cut into 64³ bricks, each compressed with zstd on its own; level 0 is the volume,
//! each next level halves every axis, down to the first level that fits in one brick. Bricks at the
//! far edges are cut to the volume instead of padded.
//!
//! A brick is packed as all its low bytes, then all its high bytes, then zstd: CT noise sits in the
//! low bytes, and apart they pack to 42–57% of the raw size where interleaved they pack to 51–68%.
//!
//! On disk, in the cache folder: `bricks.bin`, the compressed bricks one after another, and
//! `index.json`, the volume, each level's size and where each brick is. The writer builds every
//! level in one pass over the slices, holding one 64-slice slab per level, so memory does not grow
//! with the volume's depth. The folder is written beside its name and renamed when complete; a
//! cache folder is always whole, and can be deleted any time to be built again.

use crate::volume::{BrickSink, NODATA, VolumeInfo};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const BRICK: u32 = 64;
const FORMAT: u32 = 1;
/// Level 1 packs as small as 3 or 9 here once the bytes are split (VV-03, §14.2), and is fastest.
const ZSTD_LEVEL: i32 = 1;

fn ceil_div(a: u32, b: u32) -> u32 {
    a.div_ceil(b)
}

fn half(dims: [u32; 3]) -> [u32; 3] {
    dims.map(|d| ceil_div(d, 2))
}

/// The size of every level, from the volume down to the first that fits in one brick.
pub fn level_dims(dims: [u32; 3]) -> Vec<[u32; 3]> {
    let mut out = vec![dims];
    while out.last().expect("one").iter().any(|d| *d > BRICK) {
        out.push(half(*out.last().expect("one")));
    }
    out
}

fn bricks_of(dims: [u32; 3]) -> [u32; 3] {
    dims.map(|d| ceil_div(d, BRICK))
}

/// The voxels brick `b` of a level of size `dims` covers along each axis.
pub fn brick_extent(dims: [u32; 3], b: [u32; 3]) -> [u32; 3] {
    [0, 1, 2].map(|a| (dims[a] - b[a] * BRICK).min(BRICK))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LevelIndex {
    dims: [u32; 3],
    /// `[offset, length]` in `bricks.bin`, bricks in k, j, i order (i fastest).
    bricks: Vec<[u64; 2]>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Index {
    format: u32,
    brick: u32,
    info: VolumeInfo,
    levels: Vec<LevelIndex>,
}

struct LevelWriter {
    dims: [u32; 3],
    /// Up to 64 slices waiting to become a row of bricks.
    slab: Vec<i16>,
    slab_k0: u32,
    received: u32,
    /// An even slice waiting for its odd neighbour, to make one slice of the next level.
    pair: Option<Vec<i16>>,
    index: Vec<[u64; 2]>,
}

/// Writes a brick cache as a reader hands it slices.
pub struct BrickWriter {
    dir: PathBuf,
    partial: PathBuf,
    out: BufWriter<File>,
    offset: u64,
    info: Option<VolumeInfo>,
    levels: Vec<LevelWriter>,
}

impl BrickWriter {
    pub fn create(dir: &Path) -> std::io::Result<Self> {
        let mut partial = dir.as_os_str().to_owned();
        partial.push(format!(".partial-{}", std::process::id()));
        let partial = PathBuf::from(partial);
        if partial.exists() {
            std::fs::remove_dir_all(&partial)?;
        }
        std::fs::create_dir_all(&partial)?;
        let out = BufWriter::with_capacity(1 << 20, File::create(partial.join("bricks.bin"))?);
        Ok(Self {
            dir: dir.to_path_buf(),
            partial,
            out,
            offset: 0,
            info: None,
            levels: Vec::new(),
        })
    }

    fn push(&mut self, l: usize, values: Vec<i16>) -> std::io::Result<()> {
        let nodata = self.info.as_ref().expect("begun").has_nodata;
        let last_level = l + 1 == self.levels.len();
        let lv = &mut self.levels[l];
        lv.slab.extend_from_slice(&values);
        lv.received += 1;
        let depth = lv.dims[2];
        let full = lv.received - lv.slab_k0 == BRICK || lv.received == depth;
        let next = if last_level {
            None
        } else if lv.pair.is_none() && lv.received < depth {
            lv.pair = Some(values);
            None
        } else {
            let first = lv.pair.take();
            let (a, b) = match &first {
                Some(a) => (a.as_slice(), Some(values.as_slice())),
                None => (values.as_slice(), None),
            };
            Some(downsample(a, b, lv.dims[0], lv.dims[1], nodata))
        };
        if full {
            self.flush(l)?;
        }
        if let Some(down) = next {
            self.push(l + 1, down)?;
        }
        Ok(())
    }

    fn flush(&mut self, l: usize) -> std::io::Result<()> {
        let lv = &mut self.levels[l];
        let [w, h, _] = lv.dims;
        let depth = lv.received - lv.slab_k0;
        let [nbi, nbj, _] = bricks_of(lv.dims);
        let bk = lv.slab_k0 / BRICK;
        let mut brick: Vec<i16> = Vec::with_capacity((BRICK * BRICK * BRICK) as usize);
        let mut bytes = Vec::with_capacity(brick.capacity() * 2);
        for bj in 0..nbj {
            for bi in 0..nbi {
                let [bw, bh, _] = brick_extent(lv.dims, [bi, bj, 0]);
                brick.clear();
                for k in 0..depth {
                    for j in 0..bh {
                        let row = ((k * h + bj * BRICK + j) * w + bi * BRICK) as usize;
                        brick.extend_from_slice(&lv.slab[row..row + bw as usize]);
                    }
                }
                bytes.clear();
                bytes.extend(brick.iter().map(|v| v.to_le_bytes()[0]));
                bytes.extend(brick.iter().map(|v| v.to_le_bytes()[1]));
                let packed = zstd::bulk::compress(&bytes, ZSTD_LEVEL)?;
                self.out.write_all(&packed)?;
                lv.index[((bk * nbj + bj) * nbi + bi) as usize] =
                    [self.offset, packed.len() as u64];
                self.offset += packed.len() as u64;
            }
        }
        lv.slab.clear();
        lv.slab_k0 = lv.received;
        Ok(())
    }

    /// Writes the index and puts the folder in place. Fails if the reader stopped short.
    pub fn finish(mut self) -> std::io::Result<BrickStore> {
        let info = self
            .info
            .take()
            .ok_or_else(|| std::io::Error::other("no volume was written"))?;
        if let Some(l) = self.levels.iter().find(|l| l.received != l.dims[2]) {
            return Err(std::io::Error::other(format!(
                "{} of {} slices were written",
                l.received, l.dims[2]
            )));
        }
        self.out.flush()?;
        self.out.get_ref().sync_all()?;
        let index = Index {
            format: FORMAT,
            brick: BRICK,
            info,
            levels: self
                .levels
                .drain(..)
                .map(|l| LevelIndex {
                    dims: l.dims,
                    bricks: l.index,
                })
                .collect(),
        };
        std::fs::write(
            self.partial.join("index.json"),
            serde_json::to_vec(&index).map_err(std::io::Error::other)?,
        )?;
        if self.dir.exists() {
            std::fs::remove_dir_all(&self.dir)?;
        }
        std::fs::rename(&self.partial, &self.dir)?;
        BrickStore::open(&self.dir)
    }
}

impl BrickSink for BrickWriter {
    fn begin(&mut self, info: &VolumeInfo) -> std::io::Result<()> {
        self.levels = level_dims(info.dims)
            .into_iter()
            .map(|dims| {
                let [a, b, c] = bricks_of(dims);
                LevelWriter {
                    dims,
                    slab: Vec::with_capacity((dims[0] * dims[1] * BRICK.min(dims[2])) as usize),
                    slab_k0: 0,
                    received: 0,
                    pair: None,
                    index: vec![[0, 0]; (a * b * c) as usize],
                }
            })
            .collect();
        self.info = Some(info.clone());
        Ok(())
    }

    fn slice(&mut self, values: &[i16]) -> std::io::Result<()> {
        let [w, h, _] = self.info.as_ref().expect("begun").dims;
        if values.len() != (w * h) as usize {
            return Err(std::io::Error::other(format!(
                "{} values for a {w}x{h} slice",
                values.len()
            )));
        }
        self.push(0, values.to_vec())
    }
}

impl Drop for BrickWriter {
    fn drop(&mut self) {
        // A writer dropped before `finish` leaves nothing half-written.
        if self.partial.exists() {
            let _ = std::fs::remove_dir_all(&self.partial);
        }
    }
}

/// One slice of the next level from two neighbouring slices (or the last, alone): the mean of
/// each 2×2×2 block, leaving out voxels with no data; a block with none is no data.
fn downsample(a: &[i16], b: Option<&[i16]>, w: u32, h: u32, nodata: bool) -> Vec<i16> {
    let (hw, hh) = (ceil_div(w, 2), ceil_div(h, 2));
    let mut out = Vec::with_capacity((hw * hh) as usize);
    for j in 0..hh {
        for i in 0..hw {
            let (mut sum, mut n) = (0i32, 0i32);
            for s in std::iter::once(a).chain(b) {
                for jj in (2 * j)..(2 * j + 2).min(h) {
                    for ii in (2 * i)..(2 * i + 2).min(w) {
                        let v = s[(jj * w + ii) as usize];
                        if !(nodata && v == NODATA) {
                            sum += v as i32;
                            n += 1;
                        }
                    }
                }
            }
            out.push(if n == 0 {
                NODATA
            } else {
                (sum as f64 / n as f64).round() as i16
            });
        }
    }
    out
}

/// A complete brick cache, read brick by brick.
pub struct BrickStore {
    index: Index,
    data: Mutex<File>,
}

impl BrickStore {
    pub fn open(dir: &Path) -> std::io::Result<Self> {
        let index: Index = serde_json::from_slice(&std::fs::read(dir.join("index.json"))?)
            .map_err(std::io::Error::other)?;
        if index.format != FORMAT || index.brick != BRICK {
            return Err(std::io::Error::other("a brick cache of another format"));
        }
        Ok(Self {
            index,
            data: Mutex::new(File::open(dir.join("bricks.bin"))?),
        })
    }

    pub fn info(&self) -> &VolumeInfo {
        &self.index.info
    }

    pub fn levels(&self) -> usize {
        self.index.levels.len()
    }

    pub fn level_dims(&self, level: usize) -> [u32; 3] {
        self.index.levels[level].dims
    }

    /// The voxels of brick `b` of `level`, i fastest, sized by [`brick_extent`].
    pub fn brick(&self, level: usize, b: [u32; 3]) -> std::io::Result<Vec<i16>> {
        let lv = &self.index.levels[level];
        let [nbi, nbj, nbk] = bricks_of(lv.dims);
        if b[0] >= nbi || b[1] >= nbj || b[2] >= nbk {
            return Err(std::io::Error::other(format!(
                "no brick {b:?} at level {level}"
            )));
        }
        let [offset, len] = lv.bricks[((b[2] * nbj + b[1]) * nbi + b[0]) as usize];
        let mut packed = vec![0u8; len as usize];
        {
            let mut f = self.data.lock().expect("not poisoned");
            f.seek(SeekFrom::Start(offset))?;
            f.read_exact(&mut packed)?;
        }
        let [bw, bh, bd] = brick_extent(lv.dims, b);
        let n = (bw * bh * bd) as usize;
        let bytes = zstd::bulk::decompress(&packed, n * 2)?;
        if bytes.len() != n * 2 {
            return Err(std::io::Error::other(format!(
                "brick {b:?} at level {level} is damaged"
            )));
        }
        let (lo, hi) = bytes.split_at(n);
        Ok(lo
            .iter()
            .zip(hi)
            .map(|(l, h)| i16::from_le_bytes([*l, *h]))
            .collect())
    }

    /// Axial slice `k` of `level`, gathered from the bricks it crosses.
    pub fn slice_k(&self, level: usize, k: u32) -> std::io::Result<Vec<i16>> {
        let dims = self.level_dims(level);
        let [w, h, _] = dims;
        let [nbi, nbj, _] = bricks_of(dims);
        let (bk, kk) = (k / BRICK, k % BRICK);
        let mut out = vec![0i16; (w * h) as usize];
        for bj in 0..nbj {
            for bi in 0..nbi {
                let [bw, bh, _] = brick_extent(dims, [bi, bj, bk]);
                let brick = self.brick(level, [bi, bj, bk])?;
                for j in 0..bh {
                    let from = ((kk * bh + j) * bw) as usize;
                    let to = ((bj * BRICK + j) * w + bi * BRICK) as usize;
                    out[to..to + bw as usize].copy_from_slice(&brick[from..from + bw as usize]);
                }
            }
        }
        Ok(out)
    }

    /// Bytes of compressed bricks, all levels.
    pub fn packed_bytes(&self) -> u64 {
        self.index
            .levels
            .iter()
            .flat_map(|l| l.bricks.iter())
            .map(|[_, len]| len)
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::{DType, ValueMeaning};

    fn info(dims: [u32; 3], has_nodata: bool) -> VolumeInfo {
        VolumeInfo {
            dims,
            spacing: [0.7, 0.7, 1.25],
            origin: [0.0; 3],
            direction: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            dtype: DType::I16,
            value: ValueMeaning::Calibrated { unit: "HU".into() },
            has_nodata,
            meta: Default::default(),
        }
    }

    fn value(i: u32, j: u32, k: u32) -> i16 {
        ((i * 7 + j * 13 + k * 31) % 3000) as i16 - 1024
    }

    fn write(dir: &Path, info: &VolumeInfo, f: impl Fn(u32, u32, u32) -> i16) -> BrickStore {
        let mut w = BrickWriter::create(dir).unwrap();
        w.begin(info).unwrap();
        let [x, y, z] = info.dims;
        for k in 0..z {
            let s: Vec<i16> = (0..y)
                .flat_map(|j| (0..x).map(move |i| (i, j)))
                .map(|(i, j)| f(i, j, k))
                .collect();
            w.slice(&s).unwrap();
        }
        w.finish().unwrap()
    }

    #[test]
    fn levels_halve_down_to_one_brick() {
        assert_eq!(
            level_dims([512, 512, 262]),
            [
                [512, 512, 262],
                [256, 256, 131],
                [128, 128, 66],
                [64, 64, 33]
            ]
        );
        assert_eq!(level_dims([10, 10, 3]), [[10, 10, 3]]);
        assert_eq!(level_dims([65, 1, 1]), [[65, 1, 1], [33, 1, 1]]);
    }

    #[test]
    fn bricks_give_back_every_voxel() {
        // Not a multiple of 64 on any axis, so edge bricks are cut on all three.
        let dims = [130, 70, 150];
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let store = write(&cache, &info(dims, false), value);
        assert_eq!(store.levels(), 3);
        for k in [0, 63, 64, 127, 128, 149] {
            let s = store.slice_k(0, k).unwrap();
            for j in 0..dims[1] {
                for i in 0..dims[0] {
                    assert_eq!(s[(j * dims[0] + i) as usize], value(i, j, k), "{i},{j},{k}");
                }
            }
        }
        assert_eq!(
            store.brick(0, [2, 1, 2]).unwrap().len(),
            (2 * 6 * 22) as usize
        );
        assert!(store.brick(0, [3, 0, 0]).is_err());
        // Only the finished folder is left.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(names, ["cache"]);
        let reopened = BrickStore::open(&cache).unwrap();
        assert_eq!(reopened.info(), store.info());
    }

    #[test]
    fn the_pyramid_averages_and_leaves_out_nodata() {
        // Odd sizes: the last row, column and slice of each level average fewer voxels.
        let dims = [129, 65, 67];
        let dir = tempfile::tempdir().unwrap();
        // A circle of data inside no-data corners, as a CT's field of view.
        let f = |i: u32, j: u32, k: u32| {
            let (di, dj) = (i as f64 - 64.0, j as f64 - 32.0);
            if di * di + dj * dj > 30.0 * 30.0 {
                NODATA
            } else {
                value(i, j, k)
            }
        };
        let store = write(&dir.path().join("c"), &info(dims, true), f);
        assert_eq!(store.levels(), 3);
        let [w1, h1, d1] = store.level_dims(1);
        assert_eq!([w1, h1, d1], [65, 33, 34]);
        for k in [0, 20, 33] {
            let s = store.slice_k(1, k).unwrap();
            for j in 0..h1 {
                for i in 0..w1 {
                    let mut vals = Vec::new();
                    for kk in 2 * k..(2 * k + 2).min(dims[2]) {
                        for jj in 2 * j..(2 * j + 2).min(dims[1]) {
                            for ii in 2 * i..(2 * i + 2).min(dims[0]) {
                                let v = f(ii, jj, kk);
                                if v != NODATA {
                                    vals.push(v as f64);
                                }
                            }
                        }
                    }
                    let want = if vals.is_empty() {
                        NODATA
                    } else {
                        (vals.iter().sum::<f64>() / vals.len() as f64).round() as i16
                    };
                    assert_eq!(s[(j * w1 + i) as usize], want, "{i},{j},{k}");
                }
            }
        }
    }

    #[test]
    fn a_short_volume_is_not_finished() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("c");
        let mut w = BrickWriter::create(&cache).unwrap();
        w.begin(&info([4, 4, 3], false)).unwrap();
        w.slice(&[0; 16]).unwrap();
        assert!(w.finish().is_err());
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "no partial folder left"
        );
    }
}
