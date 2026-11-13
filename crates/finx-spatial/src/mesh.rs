//! Triangle meshes (spatial-design §4.1): reading STL (binary and ASCII), OBJ and PLY into one
//! [`Mesh`], surfaces of labels, decimation into levels of detail, and the binary form the viewer
//! loads. GLB is read by the viewer itself; the kernel only writes [`encode`]'s format.

use crate::algo::Mask;
use std::collections::{BinaryHeap, HashMap};

/// Triangles over shared vertices, in the source's units (LPS mm for surfaces of a volume).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mesh {
    pub positions: Vec<[f32; 3]>,
    /// Three per triangle, counter-clockwise seen from outside.
    pub indices: Vec<u32>,
}

impl Mesh {
    pub fn triangles(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn is_empty(&self) -> bool {
        self.indices.is_empty()
    }

    /// `[min, max]`; zeros when there are no vertices.
    pub fn bounds(&self) -> [[f32; 3]; 2] {
        if self.positions.is_empty() {
            return [[0.0; 3]; 2];
        }
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for p in &self.positions {
            for a in 0..3 {
                lo[a] = lo[a].min(p[a]);
                hi[a] = hi[a].max(p[a]);
            }
        }
        [lo, hi]
    }

    /// Every coordinate is finite and every index names a vertex.
    pub fn is_valid(&self) -> bool {
        self.indices.len().is_multiple_of(3)
            && self.positions.iter().all(|p| p.iter().all(|c| c.is_finite()))
            && self.indices.iter().all(|i| (*i as usize) < self.positions.len())
    }

    /// The enclosed volume (divergence theorem); meaningful for closed, outward-facing meshes.
    pub fn signed_volume(&self) -> f64 {
        self.indices
            .as_chunks::<3>().0.iter()
            .map(|t| {
                let [a, b, c] = [0, 1, 2].map(|k| self.positions[t[k] as usize].map(|x| x as f64));
                (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                    + a[2] * (b[0] * c[1] - b[1] * c[0]))
                    / 6.0
            })
            .sum()
    }

    /// Area-weighted vertex normals, unit length (zero for unused vertices).
    pub fn normals(&self) -> Vec<[f32; 3]> {
        let mut n = vec![[0f32; 3]; self.positions.len()];
        for t in self.indices.as_chunks::<3>().0 {
            let [a, b, c] = [0, 1, 2].map(|k| self.positions[t[k] as usize]);
            let f = cross(sub(b, a), sub(c, a));
            for k in t {
                for x in 0..3 {
                    n[*k as usize][x] += f[x];
                }
            }
        }
        for v in &mut n {
            let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if l > 0.0 {
                *v = v.map(|x| x / l);
            }
        }
        n
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum MeshError {
    #[error("not a mesh format the kernel reads (STL, OBJ, PLY)")]
    Unknown,
    #[error("GLB is read by the viewer, not the kernel")]
    Glb,
    #[error("{format}: {message}")]
    Bad { format: &'static str, message: String },
}

fn bad(format: &'static str, message: impl Into<String>) -> MeshError {
    MeshError::Bad {
        format,
        message: message.into(),
    }
}

/// The formats [`read`] tells apart, by content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    StlBinary,
    StlAscii,
    Obj,
    Ply,
    Glb,
}

/// The format of some bytes, by content, not by name.
pub fn sniff(bytes: &[u8]) -> Option<Format> {
    if bytes.starts_with(b"glTF") {
        return Some(Format::Glb);
    }
    if bytes.starts_with(b"ply\n") || bytes.starts_with(b"ply\r\n") {
        return Some(Format::Ply);
    }
    // Binary STL: an 80-byte header (which may well start with "solid"), a count, 50 bytes each.
    if bytes.len() >= 84 {
        let n = u32::from_le_bytes(bytes[80..84].try_into().expect("4")) as u64;
        if 84 + 50 * n == bytes.len() as u64 {
            return Some(Format::StlBinary);
        }
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]);
    let trimmed = head.trim_start();
    if trimmed.starts_with("solid") && head.contains("facet") {
        return Some(Format::StlAscii);
    }
    if head
        .lines()
        .any(|l| l.starts_with("v ") || l.starts_with("f ") || l.starts_with("o ") || l.starts_with("g "))
    {
        return Some(Format::Obj);
    }
    None
}

/// Reads STL, OBJ or PLY, found by content. Vertices of STL triangles are welded by position.
pub fn read(bytes: &[u8]) -> Result<Mesh, MeshError> {
    let mesh = match sniff(bytes).ok_or(MeshError::Unknown)? {
        Format::Glb => return Err(MeshError::Glb),
        Format::StlBinary => read_stl_binary(bytes),
        Format::StlAscii => read_stl_ascii(bytes)?,
        Format::Obj => read_obj(bytes)?,
        Format::Ply => read_ply(bytes)?,
    };
    if !mesh.is_valid() {
        return Err(bad("mesh", "non-finite coordinates or indices past the vertices"));
    }
    Ok(mesh)
}

#[derive(Default)]
struct Welder {
    mesh: Mesh,
    seen: HashMap<[u32; 3], u32>,
}

impl Welder {
    fn vertex(&mut self, p: [f32; 3]) -> u32 {
        // -0.0 and 0.0 are one point.
        let key = p.map(|x| if x == 0.0 { 0 } else { x.to_bits() });
        *self.seen.entry(key).or_insert_with(|| {
            self.mesh.positions.push(p);
            (self.mesh.positions.len() - 1) as u32
        })
    }

    fn triangle(&mut self, t: [[f32; 3]; 3]) {
        let [a, b, c] = t.map(|p| self.vertex(p));
        if a != b && b != c && a != c {
            self.mesh.indices.extend([a, b, c]);
        }
    }
}

fn read_stl_binary(bytes: &[u8]) -> Mesh {
    let n = u32::from_le_bytes(bytes[80..84].try_into().expect("4")) as usize;
    let mut w = Welder::default();
    for t in 0..n {
        let rec = &bytes[84 + 50 * t..84 + 50 * t + 50];
        let f = |o: usize| f32::from_le_bytes(rec[o..o + 4].try_into().expect("4"));
        let v = |k: usize| [f(12 + 12 * k), f(16 + 12 * k), f(20 + 12 * k)];
        w.triangle([v(0), v(1), v(2)]);
    }
    w.mesh
}

fn read_stl_ascii(bytes: &[u8]) -> Result<Mesh, MeshError> {
    let text = std::str::from_utf8(bytes).map_err(|_| bad("STL", "not UTF-8 text"))?;
    let mut w = Welder::default();
    let mut corners: Vec<[f32; 3]> = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let mut it = line.split_whitespace();
        match it.next() {
            Some("vertex") => {
                let p: Vec<f32> = it.map(str::parse).collect::<Result<_, _>>().map_err(|_| bad("STL", format!("line {}: bad vertex", n + 1)))?;
                let p: [f32; 3] = p.try_into().map_err(|_| bad("STL", format!("line {}: a vertex has three numbers", n + 1)))?;
                corners.push(p);
            }
            Some("endloop") => {
                // Polygons, rare in STL, as fans.
                for k in 1..corners.len().saturating_sub(1) {
                    w.triangle([corners[0], corners[k], corners[k + 1]]);
                }
                corners.clear();
            }
            _ => {}
        }
    }
    Ok(w.mesh)
}

fn read_obj(bytes: &[u8]) -> Result<Mesh, MeshError> {
    let text = String::from_utf8_lossy(bytes);
    let mut mesh = Mesh::default();
    for (n, line) in text.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("");
        let mut it = line.split_whitespace();
        match it.next() {
            Some("v") => {
                let p: Vec<f32> = it.take(3).map(str::parse).collect::<Result<_, _>>().map_err(|_| bad("OBJ", format!("line {}: bad vertex", n + 1)))?;
                let p: [f32; 3] = p.try_into().map_err(|_| bad("OBJ", format!("line {}: a vertex has three numbers", n + 1)))?;
                mesh.positions.push(p);
            }
            Some("f") => {
                let count = mesh.positions.len() as i64;
                let idx: Vec<u32> = it
                    .map(|c| {
                        let i: i64 = c.split('/').next().unwrap_or("").parse().map_err(|_| bad("OBJ", format!("line {}: bad face", n + 1)))?;
                        // 1-based; negative counts back from the last vertex.
                        let i = if i < 0 { count + i } else { i - 1 };
                        if i < 0 || i >= count {
                            return Err(bad("OBJ", format!("line {}: face names a missing vertex", n + 1)));
                        }
                        Ok(i as u32)
                    })
                    .collect::<Result<_, _>>()?;
                for k in 1..idx.len().saturating_sub(1) {
                    mesh.indices.extend([idx[0], idx[k], idx[k + 1]]);
                }
            }
            _ => {}
        }
    }
    Ok(mesh)
}

#[derive(Clone, Copy, PartialEq)]
enum Encoding {
    Ascii,
    Le,
    Be,
}

fn ply_size(t: &str) -> Option<usize> {
    Some(match t {
        "char" | "int8" | "uchar" | "uint8" => 1,
        "short" | "int16" | "ushort" | "uint16" => 2,
        "int" | "int32" | "uint" | "uint32" | "float" | "float32" => 4,
        "double" | "float64" => 8,
        _ => return None,
    })
}

struct PlyReader<'a> {
    enc: Encoding,
    data: &'a [u8],
    pos: usize,
    words: std::str::SplitAsciiWhitespace<'a>,
}

impl PlyReader<'_> {
    fn value(&mut self, t: &str) -> Result<f64, MeshError> {
        if self.enc == Encoding::Ascii {
            return self.words.next().and_then(|w| w.parse().ok()).ok_or_else(|| bad("PLY", "short or bad ASCII data"));
        }
        let n = ply_size(t).ok_or_else(|| bad("PLY", format!("unknown type {t}")))?;
        let b = self.data.get(self.pos..self.pos + n).ok_or_else(|| bad("PLY", "data ends early"))?;
        self.pos += n;
        let mut a = [0u8; 8];
        a[..n].copy_from_slice(b);
        if self.enc == Encoding::Be {
            a[..n].reverse();
        }
        let a4 = [a[0], a[1], a[2], a[3]];
        Ok(match t {
            "char" | "int8" => a[0] as i8 as f64,
            "uchar" | "uint8" => a[0] as f64,
            "short" | "int16" => i16::from_le_bytes([a[0], a[1]]) as f64,
            "ushort" | "uint16" => u16::from_le_bytes([a[0], a[1]]) as f64,
            "int" | "int32" => i32::from_le_bytes(a4) as f64,
            "uint" | "uint32" => u32::from_le_bytes(a4) as f64,
            "float" | "float32" => f32::from_le_bytes(a4) as f64,
            _ => f64::from_le_bytes(a),
        })
    }
}

enum Prop {
    Scalar(String, String),
    List(String, String, String),
}

fn read_ply(bytes: &[u8]) -> Result<Mesh, MeshError> {
    let end = bytes
        .windows(10)
        .position(|w| w == b"end_header")
        .ok_or_else(|| bad("PLY", "no end_header"))?;
    let mut body = end + 10;
    while body < bytes.len() && (bytes[body] == b'\r' || bytes[body] == b' ') {
        body += 1;
    }
    if bytes.get(body) == Some(&b'\n') {
        body += 1;
    }
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| bad("PLY", "header is not text"))?;
    let mut enc = None;
    let mut elements: Vec<(String, usize, Vec<Prop>)> = Vec::new();
    for line in header.lines() {
        let w: Vec<&str> = line.split_whitespace().collect();
        match w.as_slice() {
            ["format", f, ..] => {
                enc = Some(match *f {
                    "ascii" => Encoding::Ascii,
                    "binary_little_endian" => Encoding::Le,
                    "binary_big_endian" => Encoding::Be,
                    _ => return Err(bad("PLY", format!("unknown format {f}"))),
                })
            }
            ["element", name, count] => elements.push((
                name.to_string(),
                count.parse().map_err(|_| bad("PLY", "bad element count"))?,
                Vec::new(),
            )),
            ["property", "list", c, t, name] => elements
                .last_mut()
                .ok_or_else(|| bad("PLY", "property before element"))?
                .2
                .push(Prop::List(c.to_string(), t.to_string(), name.to_string())),
            ["property", t, name] => elements
                .last_mut()
                .ok_or_else(|| bad("PLY", "property before element"))?
                .2
                .push(Prop::Scalar(t.to_string(), name.to_string())),
            _ => {}
        }
    }
    let enc = enc.ok_or_else(|| bad("PLY", "no format line"))?;
    let text = if enc == Encoding::Ascii {
        std::str::from_utf8(&bytes[body..]).map_err(|_| bad("PLY", "ASCII data is not text"))?
    } else {
        ""
    };
    let mut r = PlyReader {
        enc,
        data: bytes,
        pos: body,
        words: text.split_ascii_whitespace(),
    };
    let mut mesh = Mesh::default();
    for (name, count, props) in &elements {
        // A cap so a lying count cannot ask for a huge allocation before the data runs out.
        if *count > bytes.len() {
            return Err(bad("PLY", "element count larger than the file"));
        }
        for _ in 0..*count {
            let mut p = [0f32; 3];
            for prop in props {
                match prop {
                    Prop::Scalar(t, pname) => {
                        let v = r.value(t)?;
                        if name == "vertex" {
                            match pname.as_str() {
                                "x" => p[0] = v as f32,
                                "y" => p[1] = v as f32,
                                "z" => p[2] = v as f32,
                                _ => {}
                            }
                        }
                    }
                    Prop::List(ct, t, pname) => {
                        let n = r.value(ct)? as usize;
                        if n > 1 << 16 {
                            return Err(bad("PLY", "a face with too many corners"));
                        }
                        let mut idx = Vec::with_capacity(n);
                        for _ in 0..n {
                            idx.push(r.value(t)?);
                        }
                        if name == "face" && (pname == "vertex_indices" || pname == "vertex_index") {
                            let idx: Vec<u32> = idx.into_iter().map(|i| i as u32).collect();
                            for k in 1..idx.len().saturating_sub(1) {
                                mesh.indices.extend([idx[0], idx[k], idx[k + 1]]);
                            }
                        }
                    }
                }
            }
            if name == "vertex" {
                mesh.positions.push(p);
            }
        }
    }
    Ok(mesh)
}

/// The binary form the viewer loads: a 48-byte header, then the positions (f32 x, y, z each),
/// the normals (same, when flag bit 0 is set), then the indices (u32). All little endian.
///
/// | offset | field |
/// |---|---|
/// | 0 | `FXMS` |
/// | 4 | version, u16 (1) |
/// | 6 | flags, u16: bit 0 normals follow the positions |
/// | 8 | vertex count, u32 |
/// | 12 | index count, u32 (three per triangle) |
/// | 16 | bounds min x, y, z, then max x, y, z: f32 ×6 |
/// | 40 | reserved, 8 bytes of zero |
pub const MAGIC: &[u8; 4] = b"FXMS";
pub const HEADER: usize = 48;

pub fn encode(mesh: &Mesh, with_normals: bool) -> Vec<u8> {
    let nv = mesh.positions.len();
    let mut out = Vec::with_capacity(HEADER + nv * 12 * (1 + with_normals as usize) + mesh.indices.len() * 4);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(with_normals as u16).to_le_bytes());
    out.extend_from_slice(&(nv as u32).to_le_bytes());
    out.extend_from_slice(&(mesh.indices.len() as u32).to_le_bytes());
    for c in mesh.bounds().iter().flatten() {
        out.extend_from_slice(&c.to_le_bytes());
    }
    out.extend_from_slice(&[0u8; 8]);
    for p in &mesh.positions {
        for c in p {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    if with_normals {
        for p in mesh.normals() {
            for c in p {
                out.extend_from_slice(&c.to_le_bytes());
            }
        }
    }
    for i in &mesh.indices {
        out.extend_from_slice(&i.to_le_bytes());
    }
    out
}

/// Reads [`encode`]'s format back (normals dropped).
pub fn decode(bytes: &[u8]) -> Result<Mesh, MeshError> {
    let e = |m: &str| bad("FXMS", m);
    if bytes.len() < HEADER || &bytes[..4] != MAGIC {
        return Err(e("not an encoded mesh"));
    }
    let u16_at = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]);
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().expect("4"));
    if u16_at(4) != 1 {
        return Err(e("unknown version"));
    }
    let normals = u16_at(6) & 1 == 1;
    let (nv, ni) = (u32_at(8) as usize, u32_at(12) as usize);
    let need = HEADER as u64 + nv as u64 * 12 * (1 + normals as u64) + ni as u64 * 4;
    if need != bytes.len() as u64 {
        return Err(e("length does not match the counts"));
    }
    let f = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().expect("4"));
    let positions = (0..nv).map(|v| [0, 1, 2].map(|c| f(HEADER + v * 12 + c * 4))).collect();
    let at = HEADER + nv * 12 * (1 + normals as usize);
    let indices = (0..ni).map(|i| u32_at(at + i * 4)).collect();
    let mesh = Mesh { positions, indices };
    if !mesh.is_valid() {
        return Err(e("bad coordinates or indices"));
    }
    Ok(mesh)
}

/// The six tetrahedra of a cube around its diagonal 0–7 (corner bits: 1 = +i, 2 = +j, 4 = +k).
/// Neighbouring cubes cut their shared face along the same diagonal, so the surface is closed.
/// How near a corner (as a fraction of the edge) a crossing is moved onto it.
const SNAP: f64 = 0.1;

const TETS: [[usize; 4]; 6] = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
];

/// The surface of a mask in LPS mm, closed even where the mask meets the volume's faces. A large
/// surface is made from the mask at half resolution (see [`COARSE_FACES`]).
///
/// The mask is first smoothed (a 1-2-1 binomial filter along each axis) into a field in [0, 1], then the 0.5 level is extracted
/// by marching cubes, each cube cut into six tetrahedra (no case tables; the same closed, oriented
/// surface, with more triangles, which [`decimate`] takes away). Only the mask's box, one voxel
/// wider each way, is visited.
pub fn surface(mask: &Mask) -> Mesh {
    match coarse(mask) {
        Some(c) => surface_at(&c),
        None => surface_at(mask),
    }
}

/// Voxel faces between the mask and the rest above which [`surface`] works at half resolution:
/// a surface that large is decimated to [`LOD0_TRIANGLES`] anyway, and halving first is ~4× faster.
pub const COARSE_FACES: usize = 80_000;

/// The mask at half resolution (a 2×2×2 block is in when at least half its voxels are), when its
/// surface is larger than [`COARSE_FACES`] and halving keeps its volume within 3% (thin
/// structures, as vessels, stay at full resolution).
fn coarse(mask: &Mask) -> Option<Mask> {
    let g = &mask.grid;
    let [w, h, d] = g.dims.map(|x| x as usize);
    let mut faces = 0usize;
    for (n, b) in mask.data.iter().enumerate() {
        if !*b {
            continue;
        }
        let [i, j, k] = g.ijk(n).map(|x| x as usize);
        faces += (i + 1 < w && !mask.data[n + 1]) as usize
            + (j + 1 < h && !mask.data[n + w]) as usize
            + (k + 1 < d && !mask.data[n + w * h]) as usize;
    }
    if faces <= COARSE_FACES {
        return None;
    }
    let dims = g.dims.map(|x| x.div_ceil(2));
    // The centre of block (0, 0, 0) is half a voxel in from the first voxel's centre.
    let origin = g.to_patient([0.5; 3]);
    let cg = crate::algo::Grid {
        dims,
        spacing: g.spacing.map(|s| s * 2.0),
        origin,
        direction: g.direction,
    };
    let mut out = Mask::empty(cg.clone());
    let mut count = vec![0u8; cg.len()];
    for (n, b) in mask.data.iter().enumerate() {
        if *b {
            let [i, j, k] = g.ijk(n);
            count[cg.index(i / 2, j / 2, k / 2)] += 1;
        }
    }
    for (o, c) in out.data.iter_mut().zip(&count) {
        *o = *c >= 4;
    }
    let (fine, rough) = (mask.count() as f64, out.count() as f64 * 8.0);
    ((rough / fine - 1.0).abs() <= 0.03).then_some(out)
}

fn surface_at(mask: &Mask) -> Mesh {
    let g = &mask.grid;
    let Some([lo, hi]) = mask.bbox() else {
        return Mesh::default();
    };
    // The field's box: two voxels round the mask, past the volume's faces where needed (zeros).
    let lo = lo.map(|x| x as i64 - 2);
    let hi = hi.map(|x| x as i64 + 2);
    let size = [0, 1, 2].map(|a| (hi[a] - lo[a] + 1) as usize);
    let at = |i: i64, j: i64, k: i64| -> f32 {
        if i < 0 || j < 0 || k < 0 || i >= g.dims[0] as i64 || j >= g.dims[1] as i64 || k >= g.dims[2] as i64 {
            0.0
        } else if mask.data[g.index(i as u32, j as u32, k as u32)] {
            1.0
        } else {
            0.0
        }
    };
    let idx = |x: usize, y: usize, z: usize| (z * size[1] + y) * size[0] + x;
    let mut field = vec![0f32; size[0] * size[1] * size[2]];
    for z in 0..size[2] {
        for y in 0..size[1] {
            for x in 0..size[0] {
                field[idx(x, y, z)] = at(lo[0] + x as i64, lo[1] + y as i64, lo[2] + z as i64);
            }
        }
    }
    // Separable 1-2-1 blur, in place along each axis: a flat face keeps its place, corners round a little.
    let stride = [1, size[0], size[0] * size[1]];
    let mut line = Vec::new();
    for axis in 0..3 {
        let n = size[axis];
        let (a, b) = match axis {
            0 => (1, 2),
            1 => (0, 2),
            _ => (0, 1),
        };
        for v in 0..size[b] {
            for u in 0..size[a] {
                let base = u * stride[a] + v * stride[b];
                line.clear();
                line.extend((0..n).map(|q| field[base + q * stride[axis]]));
                for q in 0..n {
                    let l = if q > 0 { line[q - 1] } else { 0.0 };
                    let r = if q + 1 < n { line[q + 1] } else { 0.0 };
                    field[base + q * stride[axis]] = 0.25 * l + 0.5 * line[q] + 0.25 * r;
                }
            }
        }
    }
    let iso = 0.5f32;
    let mut mesh = Mesh::default();
    let mut edges: HashMap<(usize, usize), u32> = HashMap::new();
    let position = |n: usize| -> [f64; 3] {
        let x = n % size[0];
        let y = (n / size[0]) % size[1];
        let z = n / (size[0] * size[1]);
        g.to_patient([lo[0] as f64 + x as f64, lo[1] as f64 + y as f64, lo[2] as f64 + z as f64])
    };
    let corner = [0, 1, 2, 3, 4, 5, 6, 7].map(|c: usize| idx(c & 1, (c >> 1) & 1, (c >> 2) & 1));
    for z in 0..size[2] - 1 {
        for y in 0..size[1] - 1 {
            for x in 0..size[0] - 1 {
                let base = idx(x, y, z);
                let ids = corner.map(|c| base + c);
                let vals = ids.map(|n| field[n]);
                let inside = vals.iter().filter(|v| **v > iso).count();
                if inside == 0 || inside == 8 {
                    continue;
                }
                for tet in TETS {
                    let n = tet.map(|c| ids[c]);
                    let v = tet.map(|c| vals[c]);
                    let ins: Vec<usize> = (0..4).filter(|t| v[*t] > iso).collect();
                    let outs: Vec<usize> = (0..4).filter(|t| v[*t] <= iso).collect();
                    if ins.is_empty() || outs.is_empty() {
                        continue;
                    }
                    let mut vertex = |a: usize, b: usize, mesh: &mut Mesh| -> u32 {
                        let (na, nb) = (n[a], n[b]);
                        let t = ((iso - v[a]) / (v[b] - v[a])) as f64;
                        // A crossing very near a corner is put on the corner, shared by every
                        // edge there: fewer, better shaped triangles for the same surface.
                        let (key, t) = if t < SNAP {
                            ((na, na), 0.0)
                        } else if t > 1.0 - SNAP {
                            ((nb, nb), 1.0)
                        } else {
                            ((na.min(nb), na.max(nb)), t)
                        };
                        *edges.entry(key).or_insert_with(|| {
                            let (pa, pb) = (position(na), position(nb));
                            mesh.positions.push([0, 1, 2].map(|c| (pa[c] + t * (pb[c] - pa[c])) as f32));
                            (mesh.positions.len() - 1) as u32
                        })
                    };
                    let tris: Vec<[u32; 3]> = match (ins.len(), outs.len()) {
                        (1, 3) => vec![[0, 1, 2].map(|o| vertex(ins[0], outs[o], &mut mesh))],
                        (3, 1) => vec![[0, 1, 2].map(|i| vertex(ins[i], outs[0], &mut mesh))],
                        _ => {
                            let a = vertex(ins[0], outs[0], &mut mesh);
                            let b = vertex(ins[0], outs[1], &mut mesh);
                            let c = vertex(ins[1], outs[1], &mut mesh);
                            let d = vertex(ins[1], outs[0], &mut mesh);
                            vec![[a, b, c], [a, c, d]]
                        }
                    };
                    // Face outward: from the inside corners towards the outside ones.
                    let mean = |s: &[usize]| {
                        let mut m = [0f64; 3];
                        for t in s {
                            let p = position(n[*t]);
                            for c in 0..3 {
                                m[c] += p[c] / s.len() as f64;
                            }
                        }
                        m
                    };
                    let (mi, mo) = (mean(&ins), mean(&outs));
                    let out_dir = [0, 1, 2].map(|c| (mo[c] - mi[c]) as f32);
                    for t in tris {
                        let [a, b, c] = t.map(|k| mesh.positions[k as usize]);
                        let nrm = cross(sub(b, a), sub(c, a));
                        let d = nrm[0] * out_dir[0] + nrm[1] * out_dir[1] + nrm[2] * out_dir[2];
                        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
                            continue;
                        }
                        if d >= 0.0 {
                            mesh.indices.extend(t);
                        } else {
                            mesh.indices.extend([t[0], t[2], t[1]]);
                        }
                    }
                }
            }
        }
    }
    mesh
}

/// A symmetric 4×4 quadric, upper triangle: a², ab, ac, ad, b², bc, bd, c², cd, d².
type Quadric = [f64; 10];

fn plane_quadric(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Quadric {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len == 0.0 {
        return [0.0; 10];
    }
    // Weighted by area (len / 2): large faces hold their plane harder.
    let w = len / 2.0;
    let n = n.map(|x| x / len);
    let d = -(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]);
    let p = [n[0], n[1], n[2], d];
    let mut q = [0.0; 10];
    let mut k = 0;
    for i in 0..4 {
        for j in i..4 {
            q[k] = w * p[i] * p[j];
            k += 1;
        }
    }
    q
}

fn q_add(a: &Quadric, b: &Quadric) -> Quadric {
    std::array::from_fn(|i| a[i] + b[i])
}

fn q_eval(q: &Quadric, p: [f64; 3]) -> f64 {
    let [x, y, z] = p;
    q[0] * x * x + 2.0 * q[1] * x * y + 2.0 * q[2] * x * z + 2.0 * q[3] * x + q[4] * y * y + 2.0 * q[5] * y * z
        + 2.0 * q[6] * y
        + q[7] * z * z
        + 2.0 * q[8] * z
        + q[9]
}

/// The point minimising the quadric, when its 3×3 part is well conditioned.
fn q_optimum(q: &Quadric) -> Option<[f64; 3]> {
    let m = [[q[0], q[1], q[2]], [q[1], q[4], q[5]], [q[2], q[5], q[7]]];
    let b = [-q[3], -q[6], -q[8]];
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let scale = (q[0] + q[4] + q[7]).abs().max(1e-30);
    if det.abs() < 1e-9 * scale * scale * scale {
        return None;
    }
    let solve = |c: usize| {
        let mut mm = m;
        for r in 0..3 {
            mm[r][c] = b[r];
        }
        (mm[0][0] * (mm[1][1] * mm[2][2] - mm[1][2] * mm[2][1]) - mm[0][1] * (mm[1][0] * mm[2][2] - mm[1][2] * mm[2][0])
            + mm[0][2] * (mm[1][0] * mm[2][1] - mm[1][1] * mm[2][0]))
            / det
    };
    Some([solve(0), solve(1), solve(2)])
}

#[derive(PartialEq)]
struct Candidate {
    cost: f64,
    a: u32,
    b: u32,
    stamp: (u32, u32),
}

impl Eq for Candidate {}

impl Ord for Candidate {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        // A min-heap on cost.
        o.cost.total_cmp(&self.cost).then(o.a.cmp(&self.a)).then(o.b.cmp(&self.b))
    }
}

impl PartialOrd for Candidate {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

/// The most edges a vertex may have after a collapse.
const MAX_VALENCE: usize = 14;

/// Quadric error decimation (Garland–Heckbert) down to about `target` triangles. Collapses that
/// would flip a face or pinch the surface (more than two shared neighbours) are refused, so a
/// closed surface stays closed; it may stop above `target` when nothing else can go.
pub fn decimate(mesh: &Mesh, target: usize) -> Mesh {
    if mesh.triangles() <= target {
        return mesh.clone();
    }
    let mut pos: Vec<[f64; 3]> = mesh.positions.iter().map(|p| p.map(|x| x as f64)).collect();
    let mut faces: Vec<[u32; 3]> = mesh.indices.as_chunks::<3>().0.iter().map(|t| [t[0], t[1], t[2]]).collect();
    let mut face_alive = vec![true; faces.len()];
    let mut quad = vec![[0f64; 10]; pos.len()];
    let mut vfaces: Vec<Vec<u32>> = vec![Vec::new(); pos.len()];
    for (f, t) in faces.iter().enumerate() {
        let q = plane_quadric(pos[t[0] as usize], pos[t[1] as usize], pos[t[2] as usize]);
        for v in t {
            quad[*v as usize] = q_add(&quad[*v as usize], &q);
            vfaces[*v as usize].push(f as u32);
        }
    }
    let mut alive = vec![true; pos.len()];
    let mut stamp = vec![0u32; pos.len()];
    let place = |q: &Quadric, a: [f64; 3], b: [f64; 3]| -> ([f64; 3], f64) {
        let mid = [0, 1, 2].map(|c| (a[c] + b[c]) / 2.0);
        let mut best = (mid, q_eval(q, mid));
        for p in [a, b].into_iter().chain(q_optimum(q)) {
            let c = q_eval(q, p);
            if c < best.1 {
                best = (p, c);
            }
        }
        best
    };
    let mut heap = BinaryHeap::new();
    let mut edge_list: Vec<(u32, u32)> = faces
        .iter()
        .flat_map(|t| [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])])
        .map(|(a, b)| (a.min(b), a.max(b)))
        .collect();
    edge_list.sort_unstable();
    edge_list.dedup();
    for (a, b) in edge_list {
        let q = q_add(&quad[a as usize], &quad[b as usize]);
        let (_, cost) = place(&q, pos[a as usize], pos[b as usize]);
        heap.push(Candidate { cost, a, b, stamp: (0, 0) });
    }
    let mut live = faces.len();
    let neighbours = |v: u32, faces: &[[u32; 3]], vfaces: &[Vec<u32>], face_alive: &[bool]| -> Vec<u32> {
        let mut out: Vec<u32> = vfaces[v as usize]
            .iter()
            .filter(|f| face_alive[**f as usize])
            .flat_map(|f| faces[*f as usize])
            .filter(|x| *x != v)
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    };
    while live > target {
        let Some(c) = heap.pop() else { break };
        let (a, b) = (c.a as usize, c.b as usize);
        if !alive[a] || !alive[b] || (stamp[a], stamp[b]) != c.stamp {
            continue;
        }
        let na = neighbours(c.a, &faces, &vfaces, &face_alive);
        if na.binary_search(&c.b).is_err() {
            continue;
        }
        let nb = neighbours(c.b, &faces, &vfaces, &face_alive);
        let shared = na.iter().filter(|x| nb.binary_search(x).is_ok()).count();
        // Two shared neighbours keep the surface a manifold; a valence cap keeps flat patches,
        // where every collapse costs nothing, from piling into fans of thin slivers (and keeps
        // each step cheap).
        if shared != 2 || na.len() + nb.len() - 4 > MAX_VALENCE {
            continue;
        }
        let q = q_add(&quad[a], &quad[b]);
        let (target_p, _) = place(&q, pos[a], pos[b]);
        // Refuse when a face that stays would turn over.
        let flips = [a, b].iter().any(|&v| {
            vfaces[v].iter().filter(|f| face_alive[**f as usize]).any(|f| {
                let t = faces[*f as usize];
                if t.contains(&(a as u32)) && t.contains(&(b as u32)) {
                    return false;
                }
                let p = t.map(|x| pos[x as usize]);
                let moved = t.map(|x| if x as usize == v { target_p } else { pos[x as usize] });
                let n0 = cross64(sub64(p[1], p[0]), sub64(p[2], p[0]));
                let n1 = cross64(sub64(moved[1], moved[0]), sub64(moved[2], moved[0]));
                let l0 = dot64(n0, n0).sqrt();
                let l1 = dot64(n1, n1).sqrt();
                l1 < 1e-12 * l0.max(1e-30) || dot64(n0, n1) < 0.2 * l0 * l1
            })
        });
        if flips {
            continue;
        }
        // Collapse b into a.
        pos[a] = target_p;
        quad[a] = q;
        alive[b] = false;
        stamp[a] += 1;
        let bf = std::mem::take(&mut vfaces[b]);
        for f in bf {
            if !face_alive[f as usize] {
                continue;
            }
            let t = &mut faces[f as usize];
            if t.contains(&(a as u32)) {
                face_alive[f as usize] = false;
                live -= 1;
            } else {
                for x in t.iter_mut() {
                    if *x as usize == b {
                        *x = a as u32;
                    }
                }
                vfaces[a].push(f);
            }
        }
        vfaces[a].retain(|f| face_alive[*f as usize]);
        for n in neighbours(a as u32, &faces, &vfaces, &face_alive) {
            let q2 = q_add(&quad[a], &quad[n as usize]);
            let (_, cost) = place(&q2, pos[a], pos[n as usize]);
            let (x, y) = ((a as u32).min(n), (a as u32).max(n));
            heap.push(Candidate {
                cost,
                a: x,
                b: y,
                stamp: (stamp[x as usize], stamp[y as usize]),
            });
        }
    }
    // Compact.
    let mut remap = vec![u32::MAX; pos.len()];
    let mut out = Mesh::default();
    for (f, t) in faces.iter().enumerate() {
        if !face_alive[f] {
            continue;
        }
        for v in t {
            let r = &mut remap[*v as usize];
            if *r == u32::MAX {
                *r = out.positions.len() as u32;
                out.positions.push(pos[*v as usize].map(|x| x as f32));
            }
            out.indices.push(*r);
        }
    }
    out
}

fn sub64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot64(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// The most triangles level 0 keeps; each next level keeps a quarter of the one before.
pub const LOD0_TRIANGLES: usize = 200_000;
/// No level below this many triangles is made (beyond the first).
pub const LOD_FLOOR: usize = 2_000;

/// Up to three levels of detail: at most [`LOD0_TRIANGLES`], then a quarter, then a sixteenth,
/// stopping once a level would be under [`LOD_FLOOR`] triangles.
pub fn lods(mesh: &Mesh) -> Vec<Mesh> {
    let mut out = vec![decimate(mesh, LOD0_TRIANGLES)];
    for _ in 0..2 {
        let last = out.last().expect("one");
        let target = last.triangles() / 4;
        if target < LOD_FLOOR {
            break;
        }
        let next = decimate(last, target);
        // Decimation that stalls (many small pieces) makes no useful level.
        if next.triangles() * 5 > last.triangles() * 4 {
            break;
        }
        out.push(next);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::algo::{Grid, Mask};

    fn cube_mask() -> Mask {
        let g = Grid {
            dims: [12, 12, 12],
            spacing: [1.0, 1.0, 1.0],
            origin: [0.0; 3],
            direction: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
        };
        let mut m = Mask::empty(g.clone());
        for n in 0..g.len() {
            let p = g.ijk(n);
            m.data[n] = p.iter().all(|x| (2..10).contains(x));
        }
        m
    }

    /// Every edge is shared by exactly two triangles, with opposite directions.
    fn closed(m: &Mesh) -> bool {
        let mut e: HashMap<(u32, u32), i32> = HashMap::new();
        for t in m.indices.as_chunks::<3>().0 {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *e.entry((a, b)).or_default() += 1;
            }
        }
        e.iter().all(|((a, b), n)| *n == 1 && e.get(&(*b, *a)) == Some(&1))
    }

    #[test]
    fn a_cube_mask_gives_a_closed_outward_cube() {
        let m = surface(&cube_mask());
        assert!(m.is_valid() && !m.is_empty());
        assert!(closed(&m), "the surface is closed and consistently oriented");
        let v = m.signed_volume();
        // An 8×8×8 block whose 0.5 level sits at its voxel faces, rounded at edges by the blur.
        assert!(v > 0.0, "outward faces give a positive volume: {v}");
        assert!((v / 512.0 - 1.0).abs() < 0.12, "{v}");
        let [lo, hi] = m.bounds();
        assert!(lo.iter().all(|x| (*x - 1.5).abs() < 0.4) && hi.iter().all(|x| (*x - 9.5).abs() < 0.4), "{lo:?} {hi:?}");
        // Decimated it stays closed and about as big.
        let d = decimate(&m, m.triangles() / 8);
        assert!(d.triangles() <= m.triangles() / 8 + 2, "{}", d.triangles());
        assert!(closed(&d));
        assert!((d.signed_volume() / v - 1.0).abs() < 0.05, "{} vs {v}", d.signed_volume());
    }

    #[test]
    fn encodes_and_decodes() {
        let m = surface(&cube_mask());
        let bytes = encode(&m, true);
        assert_eq!(&bytes[..4], MAGIC);
        assert_eq!(bytes.len(), HEADER + m.positions.len() * 24 + m.indices.len() * 4);
        assert_eq!(decode(&bytes).unwrap(), m);
        assert_eq!(decode(&encode(&m, false)).unwrap(), m);
        let mut cut = bytes.clone();
        cut.pop();
        assert!(decode(&cut).is_err());
    }

    fn tetra_obj() -> &'static str {
        "# a tetrahedron\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2/1/1 3/2/2 4/3/3\n"
    }

    #[test]
    fn reads_obj_ply_and_stl() {
        let obj = read(tetra_obj().as_bytes()).unwrap();
        assert_eq!((obj.positions.len(), obj.triangles()), (4, 4));
        assert!(closed(&obj));
        assert!((obj.signed_volume() - 1.0 / 6.0).abs() < 1e-6);

        // ASCII STL of the same, unwelded.
        let mut stl = String::from("solid t\n");
        for t in obj.indices.as_chunks::<3>().0 {
            stl.push_str("facet normal 0 0 0\nouter loop\n");
            for v in t {
                let p = obj.positions[*v as usize];
                stl.push_str(&format!("vertex {} {} {}\n", p[0], p[1], p[2]));
            }
            stl.push_str("endloop\nendfacet\n");
        }
        stl.push_str("endsolid t\n");
        let a = read(stl.as_bytes()).unwrap();
        assert_eq!((a.positions.len(), a.triangles()), (4, 4), "welded");
        assert!(closed(&a));

        // Binary STL, with a header that starts like ASCII.
        let mut bin = b"solid but binary".to_vec();
        bin.resize(80, 0);
        bin.extend_from_slice(&(obj.triangles() as u32).to_le_bytes());
        for t in obj.indices.as_chunks::<3>().0 {
            bin.extend_from_slice(&[0u8; 12]);
            for v in t {
                for c in obj.positions[*v as usize] {
                    bin.extend_from_slice(&c.to_le_bytes());
                }
            }
            bin.extend_from_slice(&[0u8; 2]);
        }
        assert_eq!(sniff(&bin), Some(Format::StlBinary));
        let b = read(&bin).unwrap();
        assert_eq!((b.positions.len(), b.triangles()), (4, 4));

        let ply_ascii = "ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 9\n1 0 0 9\n1 1 0 9\n0 1 0 9\n4 0 1 2 3\n";
        let p = read(ply_ascii.as_bytes()).unwrap();
        assert_eq!((p.positions.len(), p.triangles()), (4, 2));
        assert_eq!(p.positions[2], [1.0, 1.0, 0.0]);

        let mut ply_bin = b"ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nelement face 1\nproperty list uchar uint vertex_indices\nend_header\n".to_vec();
        for p in [[0.0f64, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0]] {
            for c in p {
                ply_bin.extend_from_slice(&c.to_le_bytes());
            }
        }
        ply_bin.push(3);
        for i in [0u32, 1, 2] {
            ply_bin.extend_from_slice(&i.to_le_bytes());
        }
        let p = read(&ply_bin).unwrap();
        assert_eq!(p.positions[2], [0.0, 3.0, 0.0]);
        assert_eq!(p.indices, [0, 1, 2]);
    }

    #[test]
    fn refuses_what_it_cannot_read() {
        assert_eq!(read(b"glTF\x02\0\0\0"), Err(MeshError::Glb));
        assert_eq!(read(b"hello world"), Err(MeshError::Unknown));
        assert!(read(b"v 0 0 0\nf 1 2 3\n").is_err(), "a face past the vertices");
        assert!(read(b"v 0 nan 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n").is_err(), "NaN");
        assert!(read(b"ply\nformat binary_little_endian 1.0\nelement vertex 99999999\nproperty float x\nend_header\n").is_err());
    }

    #[test]
    fn levels_of_detail_shrink() {
        let g = Grid {
            dims: [70, 70, 70],
            spacing: [1.0; 3],
            origin: [0.0; 3],
            direction: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
        };
        let mut m = Mask::empty(g.clone());
        for n in 0..g.len() {
            let p = g.ijk(n);
            m.data[n] = p.iter().map(|x| (*x as f64 - 35.0).powi(2)).sum::<f64>() < 30.0 * 30.0;
        }
        let s = surface(&m);
        let l = lods(&s);
        assert!(l.len() >= 2, "{}", l.len());
        for w in l.windows(2) {
            assert!(w[1].triangles() < w[0].triangles());
        }
        let want = 4.0 / 3.0 * std::f64::consts::PI * 30f64.powi(3);
        for lv in &l {
            assert!(lv.is_valid() && closed(lv));
            assert!((lv.signed_volume() / want - 1.0).abs() < 0.05, "{}", lv.signed_volume());
        }
    }
}
