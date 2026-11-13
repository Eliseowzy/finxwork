//! Recipes (spatial-design §5.2): a skill's JSON that strings the generic algorithms into
//! structures. Checked strictly before anything runs: unknown fields, unknown steps and references
//! to structures not built yet are errors. Nothing in a recipe runs code.
//!
//! ```json
//! { "profile": { "orientation": "patient", "unit": "HU",
//!                "windows": { "lung": [1500, -600] }, "disclaimer": "…" },
//!   "structures": [
//!     { "id": "body", "name": "Body", "color": "#c8a48a", "opacity": 0.15, "hidden": false,
//!       "steps": [ { "threshold": [-400, null] }, { "keep_largest": 1 }, { "fill_holes": true } ] } ] }
//! ```
//!
//! Each structure starts from every voxel with data and each step narrows (or, for `fill_holes`
//! and `dilate_mm`, widens) that set. Steps:
//!
//! | step | meaning |
//! |---|---|
//! | `{"threshold": [lo, hi]}` | values within `[lo, hi]`; `null` leaves an end open |
//! | `{"keep_largest": n}` | the `n` largest 6-connected components |
//! | `{"fill_holes": true}` | fill cavities, and holes enclosed within each slice along k |
//! | `{"inside": id, "dilate_mm": d}` | within structure `id`, grown by `d` mm (default 0) |
//! | `{"outside": id, "dilate_mm": d}` | not within structure `id` grown by `d` mm |
//! | `{"from": id}` | start from structure `id` (first step only) |
//! | `{"drop_touching_border": true}` | drop components touching a face of the volume |
//! | `{"drop_smaller_than_mm3": v}` | drop components under `v` mm³ |
//! | `{"dilate_mm": d}` / `{"erode_mm": d}` | grow / shrink by a ball of `d` mm |
//! | `{"region_grow": {"seed": [x, y, z], "range": [lo, hi], "max_mm3": v}}` | grow from an LPS mm point through values in range, within the set so far, stopping at `v` mm³ |
//! | `{"split_side": "patient_right" \| "patient_left"}` | the components on that side of the set's centre (by the direction matrix); one component is cut at the centre plane |
//! | `{"connected_to_seed": "top_largest"}` | the component holding the largest enclosed 2D component of the topmost (most superior) slices; `"trachea"` is accepted as another name for it |

use crate::algo::{self, Grid, Mask, Stats};
use crate::mesh::{self, Mesh};
use crate::volume::Volume;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum RecipeError {
    #[error("recipe is not valid JSON of the right shape: {0}")]
    Parse(String),
    #[error("{at}: {message}")]
    Invalid { at: String, message: String },
    #[error("structure {id}: {message}")]
    Run { id: String, message: String },
}

fn invalid(at: impl Into<String>, message: impl Into<String>) -> RecipeError {
    RecipeError::Invalid {
        at: at.into(),
        message: message.into(),
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Profile {
    /// `"patient"` (the viewer marks L/R, A/P, S/I) or `"none"`.
    pub orientation: Option<String>,
    pub unit: Option<String>,
    /// Name, then `[width, level]`, in the recipe's order.
    pub windows: Vec<(String, [f64; 2])>,
    pub disclaimer: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    PatientRight,
    PatientLeft,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Threshold { lo: Option<f64>, hi: Option<f64> },
    KeepLargest(usize),
    FillHoles,
    Inside { id: String, dilate_mm: f64 },
    Outside { id: String, dilate_mm: f64 },
    From(String),
    DropTouchingBorder,
    DropSmallerThanMm3(f64),
    DilateMm(f64),
    ErodeMm(f64),
    RegionGrow { seed: [f64; 3], lo: f64, hi: f64, max_mm3: Option<f64> },
    SplitSide(Side),
    /// The component holding the largest enclosed 2D component near the top of the volume.
    ConnectedToTopSeed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Structure {
    pub id: String,
    pub name: String,
    pub color: String,
    pub opacity: f64,
    /// An intermediate result: built and usable by later steps, with no mesh.
    pub hidden: bool,
    pub steps: Vec<Step>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recipe {
    pub profile: Profile,
    pub structures: Vec<Structure>,
}

/// Window presets in their written order (a JSON object, read without losing order).
struct Windows(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for Windows {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Windows;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object of name: [width, level]")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut m: A) -> Result<Windows, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Value>()? {
                    out.push((k, v));
                }
                Ok(Windows(out))
            }
        }
        d.deserialize_map(V)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProfile {
    orientation: Option<String>,
    unit: Option<String>,
    windows: Option<Windows>,
    disclaimer: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawStructure {
    id: String,
    name: String,
    color: String,
    opacity: Option<f64>,
    #[serde(default)]
    hidden: bool,
    steps: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRecipe {
    profile: Option<RawProfile>,
    structures: Vec<RawStructure>,
}

const STEPS: &[&str] = &[
    "threshold",
    "keep_largest",
    "fill_holes",
    "inside",
    "outside",
    "from",
    "drop_touching_border",
    "drop_smaller_than_mm3",
    "dilate_mm",
    "erode_mm",
    "region_grow",
    "split_side",
    "connected_to_seed",
];

/// Parses and checks a recipe.
pub fn parse(json: &str) -> Result<Recipe, RecipeError> {
    let raw: RawRecipe = serde_json::from_str(json).map_err(|e| RecipeError::Parse(e.to_string()))?;
    let profile = match raw.profile {
        None => Profile::default(),
        Some(p) => {
            if let Some(o) = &p.orientation
                && o != "patient"
                && o != "none"
            {
                return Err(invalid("profile.orientation", "is \"patient\" or \"none\""));
            }
            let mut windows = Vec::new();
            for (name, v) in p.windows.map(|w| w.0).unwrap_or_default() {
                let at = format!("profile.windows.{name}");
                let pair = numbers(&v).filter(|n| n.len() == 2).ok_or_else(|| invalid(&at, "is [width, level]"))?;
                if pair[0] <= 0.0 {
                    return Err(invalid(&at, "width must be positive"));
                }
                windows.push((name, [pair[0], pair[1]]));
            }
            Profile {
                orientation: p.orientation,
                unit: p.unit,
                windows,
                disclaimer: p.disclaimer,
            }
        }
    };
    if raw.structures.is_empty() {
        return Err(invalid("structures", "is empty"));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut structures = Vec::new();
    for (s, r) in raw.structures.into_iter().enumerate() {
        let at = format!("structures[{s}]");
        if r.id.is_empty() || !r.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
            return Err(invalid(format!("{at}.id"), "is lowercase letters, digits, _ and -"));
        }
        if seen.contains(&r.id) {
            return Err(invalid(format!("{at}.id"), format!("\"{}\" is used twice", r.id)));
        }
        if r.name.trim().is_empty() {
            return Err(invalid(format!("{at}.name"), "is empty"));
        }
        let hex = r.color.strip_prefix('#').filter(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()));
        if hex.is_none() {
            return Err(invalid(format!("{at}.color"), "is #rrggbb"));
        }
        let opacity = r.opacity.unwrap_or(1.0);
        if !(0.0..=1.0).contains(&opacity) {
            return Err(invalid(format!("{at}.opacity"), "is between 0 and 1"));
        }
        if r.steps.is_empty() {
            return Err(invalid(format!("{at}.steps"), "is empty"));
        }
        let mut steps = Vec::new();
        for (n, v) in r.steps.iter().enumerate() {
            let at = format!("{at}.steps[{n}]");
            let step = parse_step(v, &at, &seen)?;
            if matches!(step, Step::From(_)) && n != 0 {
                return Err(invalid(&at, "\"from\" is the first step only"));
            }
            steps.push(step);
        }
        seen.push(r.id.clone());
        structures.push(Structure {
            id: r.id,
            name: r.name,
            color: r.color,
            opacity,
            hidden: r.hidden,
            steps,
        });
    }
    Ok(Recipe { profile, structures })
}

fn numbers(v: &Value) -> Option<Vec<f64>> {
    v.as_array()?.iter().map(Value::as_f64).collect()
}

fn positive(v: &Value, at: &str, what: &str, max: f64) -> Result<f64, RecipeError> {
    match v.as_f64() {
        Some(x) if x > 0.0 && x <= max => Ok(x),
        _ => Err(invalid(at, format!("{what} is a number above 0 and at most {max}"))),
    }
}

fn reference(v: &Value, at: &str, what: &str, seen: &[String]) -> Result<String, RecipeError> {
    let id = v.as_str().ok_or_else(|| invalid(at, format!("{what} names a structure")))?;
    if !seen.iter().any(|s| s == id) {
        return Err(invalid(at, format!("{what} \"{id}\" is not a structure built before this one")));
    }
    Ok(id.to_string())
}

fn parse_step(v: &Value, at: &str, seen: &[String]) -> Result<Step, RecipeError> {
    let obj = v.as_object().ok_or_else(|| invalid(at, "a step is an object"))?;
    // `dilate_mm` is a step of its own and an option of inside and outside.
    let owner = obj.contains_key("inside") || obj.contains_key("outside");
    let kinds: Vec<&String> = obj
        .keys()
        .filter(|k| STEPS.contains(&k.as_str()) && !(owner && k.as_str() == "dilate_mm"))
        .collect();
    let kind = match kinds.as_slice() {
        [k] => k.as_str(),
        [] => {
            let k = obj.keys().next().map(String::as_str).unwrap_or("");
            return Err(invalid(at, format!("unknown step \"{k}\"; steps are {}", STEPS.join(", "))));
        }
        _ => return Err(invalid(at, "one step per object")),
    };
    // Options a step may carry beside its key: only `dilate_mm` with inside and outside.
    let options: &[&str] = match kind {
        "inside" | "outside" => &["dilate_mm"],
        _ => &[],
    };
    if let Some(extra) = obj.keys().find(|k| k.as_str() != kind && !options.contains(&k.as_str())) {
        return Err(invalid(at, format!("unknown field \"{extra}\" in a \"{kind}\" step")));
    }
    let arg = &obj[kind];
    let must_be_true = |what: &str| {
        if arg == &Value::Bool(true) {
            Ok(())
        } else {
            Err(invalid(at, format!("{what} is true")))
        }
    };
    Ok(match kind {
        "threshold" => {
            let a = arg.as_array().filter(|a| a.len() == 2).ok_or_else(|| invalid(at, "threshold is [lo, hi], either may be null"))?;
            let end = |v: &Value| -> Result<Option<f64>, RecipeError> {
                match v {
                    Value::Null => Ok(None),
                    v => v.as_f64().map(Some).ok_or_else(|| invalid(at, "threshold ends are numbers or null")),
                }
            };
            let (lo, hi) = (end(&a[0])?, end(&a[1])?);
            if lo.is_none() && hi.is_none() {
                return Err(invalid(at, "threshold needs at least one end"));
            }
            if let (Some(l), Some(h)) = (lo, hi)
                && l > h
            {
                return Err(invalid(at, "threshold's low end is above its high end"));
            }
            Step::Threshold { lo, hi }
        }
        "keep_largest" => match arg.as_u64() {
            Some(n) if (1..=1000).contains(&n) => Step::KeepLargest(n as usize),
            _ => return Err(invalid(at, "keep_largest is a whole number from 1 to 1000")),
        },
        "fill_holes" => {
            must_be_true("fill_holes")?;
            Step::FillHoles
        }
        "drop_touching_border" => {
            must_be_true("drop_touching_border")?;
            Step::DropTouchingBorder
        }
        "inside" | "outside" => {
            let id = reference(arg, at, kind, seen)?;
            let dilate_mm = match obj.get("dilate_mm") {
                None => 0.0,
                Some(v) => match v.as_f64() {
                    Some(x) if (0.0..=100.0).contains(&x) => x,
                    _ => return Err(invalid(at, "dilate_mm is a number from 0 to 100")),
                },
            };
            if kind == "inside" {
                Step::Inside { id, dilate_mm }
            } else {
                Step::Outside { id, dilate_mm }
            }
        }
        "from" => Step::From(reference(arg, at, "from", seen)?),
        "drop_smaller_than_mm3" => Step::DropSmallerThanMm3(positive(arg, at, "drop_smaller_than_mm3", 1e9)?),
        "dilate_mm" => Step::DilateMm(positive(arg, at, "dilate_mm", 100.0)?),
        "erode_mm" => Step::ErodeMm(positive(arg, at, "erode_mm", 100.0)?),
        "region_grow" => {
            let o = arg.as_object().ok_or_else(|| invalid(at, "region_grow is {seed, range, max_mm3}"))?;
            if let Some(k) = o.keys().find(|k| !["seed", "range", "max_mm3"].contains(&k.as_str())) {
                return Err(invalid(at, format!("unknown field \"{k}\" in region_grow")));
            }
            let seed = o.get("seed").and_then(numbers).filter(|n| n.len() == 3).ok_or_else(|| invalid(at, "region_grow.seed is [x, y, z] in mm"))?;
            let range = o.get("range").and_then(numbers).filter(|n| n.len() == 2).ok_or_else(|| invalid(at, "region_grow.range is [lo, hi]"))?;
            if range[0] > range[1] {
                return Err(invalid(at, "region_grow.range's low end is above its high end"));
            }
            let max_mm3 = o.get("max_mm3").map(|v| positive(v, at, "region_grow.max_mm3", 1e9)).transpose()?;
            Step::RegionGrow {
                seed: [seed[0], seed[1], seed[2]],
                lo: range[0],
                hi: range[1],
                max_mm3,
            }
        }
        "split_side" => match arg.as_str() {
            Some("patient_right") => Step::SplitSide(Side::PatientRight),
            Some("patient_left") => Step::SplitSide(Side::PatientLeft),
            _ => return Err(invalid(at, "split_side is \"patient_right\" or \"patient_left\"")),
        },
        "connected_to_seed" => match arg.as_str() {
            Some("top_largest" | "trachea") => Step::ConnectedToTopSeed,
            _ => return Err(invalid(at, "connected_to_seed is \"top_largest\" (or \"trachea\")")),
        },
        _ => unreachable!("every step kind is handled"),
    })
}

/// One structure, built.
#[derive(Clone, Debug)]
pub struct Built {
    pub id: String,
    pub name: String,
    pub color: String,
    pub opacity: f64,
    pub hidden: bool,
    pub mask: Mask,
    /// Levels of detail, finest first; empty for hidden or empty structures.
    pub meshes: Vec<Mesh>,
    pub stats: Stats,
    /// Things worth telling: an empty result, a region grow that hit its cap.
    pub notes: Vec<String>,
    /// When it was ready, counted from the start of [`run`].
    pub millis: u64,
}

/// Runs a recipe over a volume, structure by structure in order, handing each to `on` as soon as
/// it is built and every one before it has been handed over (so the viewer can show one while the
/// next is made). Labels are made in order on this thread; each structure's surface and levels of
/// detail are made on a thread of their own meanwhile. Returns them all.
pub fn run(recipe: &Recipe, vol: &Volume, on: &mut dyn FnMut(&Built)) -> Result<Vec<Built>, RecipeError> {
    let started = Instant::now();
    std::thread::scope(|scope| {
        let mut masks: Vec<Mask> = Vec::new();
        let mut by_id: HashMap<String, usize> = HashMap::new();
        let mut pending = std::collections::VecDeque::new();
        let mut done: Vec<Built> = Vec::new();
        let mut hand_over = |pending: &mut std::collections::VecDeque<std::thread::ScopedJoinHandle<'_, Built>>, all: bool, done: &mut Vec<Built>| {
            while pending.front().is_some_and(|h| all || h.is_finished()) {
                let b = pending.pop_front().expect("front").join().expect("meshing does not panic");
                on(&b);
                done.push(b);
            }
        };
        for s in &recipe.structures {
            let mut notes = Vec::new();
            let mut mask = algo::has_data(vol);
            for step in &s.steps {
                let others = Lookup { masks: &masks, by_id: &by_id };
                mask = apply(step, mask, vol, &others, &mut notes).map_err(|message| RecipeError::Run {
                    id: s.id.clone(),
                    message,
                })?;
            }
            by_id.insert(s.id.clone(), masks.len());
            masks.push(mask.clone());
            let s = s.clone();
            pending.push_back(scope.spawn(move || {
                let stats = algo::stats(&mask, Some(vol));
                if stats.voxels == 0 {
                    notes.push("empty".into());
                }
                let meshes = if s.hidden || stats.voxels == 0 {
                    Vec::new()
                } else {
                    mesh::lods(&mesh::surface(&mask))
                };
                Built {
                    id: s.id,
                    name: s.name,
                    color: s.color,
                    opacity: s.opacity,
                    hidden: s.hidden,
                    mask,
                    meshes,
                    stats,
                    notes,
                    millis: started.elapsed().as_millis() as u64,
                }
            }));
            hand_over(&mut pending, false, &mut done);
        }
        hand_over(&mut pending, true, &mut done);
        Ok(done)
    })
}

fn apply(step: &Step, mut mask: Mask, vol: &Volume, other: &Lookup, notes: &mut Vec<String>) -> Result<Mask, String> {
    Ok(match step {
        Step::Threshold { lo, hi } => {
            mask.and(&algo::threshold(vol, *lo, *hi));
            mask
        }
        Step::KeepLargest(n) => algo::keep_largest(&mask, *n),
        Step::FillHoles => algo::fill_holes(&mask),
        Step::Inside { id, dilate_mm } => {
            let o = other.get(id);
            if *dilate_mm > 0.0 {
                mask.and(&algo::dilate_mm(o, *dilate_mm));
            } else {
                mask.and(o);
            }
            mask
        }
        Step::Outside { id, dilate_mm } => {
            let o = other.get(id);
            if *dilate_mm > 0.0 {
                mask.and_not(&algo::dilate_mm(o, *dilate_mm));
            } else {
                mask.and_not(o);
            }
            mask
        }
        Step::From(id) => other.get(id).clone(),
        Step::DropTouchingBorder => algo::drop_touching_border(&mask),
        Step::DropSmallerThanMm3(v) => algo::drop_smaller_than_mm3(&mask, *v),
        Step::DilateMm(d) => algo::dilate_mm(&mask, *d),
        Step::ErodeMm(d) => algo::erode_mm(&mask, *d),
        Step::RegionGrow { seed, lo, hi, max_mm3 } => {
            let g = &mask.grid;
            let ijk = g.to_index(*seed).map(f64::round);
            if (0..3).any(|a| ijk[a] < 0.0 || ijk[a] >= g.dims[a] as f64) {
                return Err(format!("region_grow seed {seed:?} is outside the volume"));
            }
            let ijk = ijk.map(|x| x as u32);
            match algo::region_grow(vol, ijk, *lo, *hi, *max_mm3, Some(&mask)) {
                Some((m, capped)) => {
                    if capped {
                        notes.push(format!("region_grow stopped at {} mm³", max_mm3.unwrap_or(0.0)));
                    }
                    m
                }
                None => {
                    notes.push("region_grow seed is out of range or outside the set".into());
                    Mask::empty(g.clone())
                }
            }
        }
        Step::SplitSide(side) => split_side(&mask, *side),
        Step::ConnectedToTopSeed => {
            let seed = top_seed(&mask).ok_or("connected_to_seed: no enclosed component in the topmost slices")?;
            algo::connected_to(&mask, seed)
        }
    })
}

struct Lookup<'a> {
    masks: &'a [Mask],
    by_id: &'a HashMap<String, usize>,
}

impl Lookup<'_> {
    fn get(&self, id: &str) -> &Mask {
        // Parsing checked that every reference names an earlier structure.
        &self.masks[self.by_id[id]]
    }
}


/// The voxels on one side of the patient. Side is read from the direction matrix: LPS x grows
/// towards the patient's left. With two or more components each goes whole to the side of its
/// centre; a single component is cut at the set's centre.
fn split_side(mask: &Mask, side: Side) -> Mask {
    let g = &mask.grid;
    let (labels, sizes) = algo::components(mask);
    // Patient x of a voxel is affine in its indices.
    let x_of = |ijk: [f64; 3]| g.to_patient(ijk)[0];
    let mut sum = vec![[0f64; 3]; sizes.len()];
    let mut all = [0f64; 3];
    for (n, l) in labels.iter().enumerate() {
        if *l == 0 {
            continue;
        }
        let p = g.ijk(n);
        for a in 0..3 {
            sum[*l as usize][a] += p[a] as f64;
            all[a] += p[a] as f64;
        }
    }
    let total: u64 = sizes[1..].iter().sum();
    let mut out = Mask::empty(g.clone());
    if total == 0 {
        return out;
    }
    let mid = x_of(all.map(|s| s / total as f64));
    let wanted = |x: f64| match side {
        Side::PatientRight => x < mid,
        Side::PatientLeft => x >= mid,
    };
    if sizes.len() > 2 {
        let keep: Vec<bool> = (0..sizes.len())
            .map(|l| l > 0 && wanted(x_of(sum[l].map(|s| s / sizes[l] as f64))))
            .collect();
        for (o, l) in out.data.iter_mut().zip(&labels) {
            *o = keep[*l as usize];
        }
    } else {
        for (n, o) in out.data.iter_mut().enumerate() {
            if mask.data[n] {
                let p = g.ijk(n);
                *o = wanted(x_of(p.map(|x| x as f64)));
            }
        }
    }
    out
}

/// How far down from the top the seed is looked for.
const TOP_SEARCH_MM: f64 = 40.0;
/// The least area a seed's component has in its slice.
const TOP_MIN_MM2: f64 = 20.0;

/// A voxel of the largest component (of at least [`TOP_MIN_MM2`]) that does not touch its slice's
/// edge, in the most superior slice that has one, searching [`TOP_SEARCH_MM`] down from the top.
/// "Superior" is LPS +z, found through the direction matrix, so any slice axis works.
fn top_seed(mask: &Mask) -> Option<[u32; 3]> {
    let g = &mask.grid;
    let axis = (0..3).max_by(|a, b| g.direction[*a][2].abs().total_cmp(&g.direction[*b][2].abs()))?;
    let up = g.direction[axis][2] > 0.0;
    let (u, v) = match axis {
        0 => (1, 2),
        1 => (0, 2),
        _ => (0, 1),
    };
    let depth = g.dims[axis];
    let steps = ((TOP_SEARCH_MM / g.spacing[axis]).ceil() as u32).clamp(1, depth);
    let plane = Grid {
        dims: [g.dims[u], g.dims[v], 1],
        spacing: [g.spacing[u], g.spacing[v], 1.0],
        origin: [0.0; 3],
        direction: [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
    };
    let area = g.spacing[u] * g.spacing[v];
    for s in 0..steps {
        let t = if up { depth - 1 - s } else { s };
        let mut slice = Mask::empty(plane.clone());
        let at = |a: u32, b: u32| {
            let mut p = [0u32; 3];
            p[axis] = t;
            p[u] = a;
            p[v] = b;
            p
        };
        for b in 0..g.dims[v] {
            for a in 0..g.dims[u] {
                let p = at(a, b);
                slice.data[plane.index(a, b, 0)] = mask.data[g.index(p[0], p[1], p[2])];
            }
        }
        let (labels, sizes) = algo::components(&slice);
        // Components touching the slice's edges are open to the outside, not enclosed.
        let mut open = vec![false; sizes.len()];
        for (n, l) in labels.iter().enumerate() {
            let p = plane.ijk(n);
            if p[0] == 0 || p[1] == 0 || p[0] + 1 == plane.dims[0] || p[1] + 1 == plane.dims[1] {
                open[*l as usize] = true;
            }
        }
        let best = (1..sizes.len()).filter(|l| !open[*l]).max_by_key(|l| sizes[*l]);
        if let Some(l) = best.filter(|l| sizes[*l] as f64 * area >= TOP_MIN_MM2) {
            // The component's voxel nearest its centre.
            let members: Vec<usize> = (0..labels.len()).filter(|n| labels[*n] as usize == l).collect();
            let c = members.iter().fold([0f64; 2], |acc, n| {
                let p = plane.ijk(*n);
                [acc[0] + p[0] as f64, acc[1] + p[1] as f64]
            });
            let c = [c[0] / members.len() as f64, c[1] / members.len() as f64];
            let n = *members.iter().min_by(|x, y| {
                let d = |n: usize| {
                    let p = plane.ijk(n);
                    (p[0] as f64 - c[0]).powi(2) + (p[1] as f64 - c[1]).powi(2)
                };
                d(**x).total_cmp(&d(**y))
            })?;
            let p = plane.ijk(n);
            return Some(at(p[0], p[1]));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(json: &str) -> String {
        parse(json).unwrap_err().to_string()
    }

    const OK: &str = r##"{
      "profile": { "orientation": "patient", "unit": "HU",
                   "windows": { "b": [1500, -600], "a": [400, 40] }, "disclaimer": "x" },
      "structures": [
        { "id": "body", "name": "Body", "color": "#c8a48a", "opacity": 0.15,
          "steps": [ { "threshold": [-400, null] }, { "keep_largest": 1 }, { "fill_holes": true } ] },
        { "id": "inner", "name": "Inner", "color": "#4a90d9", "hidden": true,
          "steps": [ { "from": "body" }, { "erode_mm": 2 }, { "inside": "body", "dilate_mm": 2 },
                     { "outside": "body", "dilate_mm": 0 }, { "split_side": "patient_left" },
                     { "connected_to_seed": "trachea" }, { "drop_touching_border": true },
                     { "drop_smaller_than_mm3": 20 }, { "dilate_mm": 1 },
                     { "region_grow": { "seed": [1, 2, 3], "range": [-700, -300], "max_mm3": 2000 } } ] }
      ] }"##;

    #[test]
    fn parses_every_step_in_order() {
        let r = parse(OK).unwrap();
        assert_eq!(r.profile.windows.iter().map(|w| w.0.as_str()).collect::<Vec<_>>(), ["b", "a"], "written order");
        assert_eq!(r.structures[1].steps.len(), 10);
        assert!(r.structures[1].hidden);
        assert_eq!(r.structures[0].opacity, 0.15);
        assert_eq!(r.structures[1].opacity, 1.0);
        assert_eq!(
            r.structures[1].steps[9],
            Step::RegionGrow { seed: [1.0, 2.0, 3.0], lo: -700.0, hi: -300.0, max_mm3: Some(2000.0) }
        );
    }

    fn one(steps: &str) -> String {
        format!(r##"{{ "structures": [ {{ "id": "a", "name": "A", "color": "#000000", "steps": [ {{ "threshold": [0, null] }} ] }},
                                      {{ "id": "b", "name": "B", "color": "#ffffff", "steps": {steps} }} ] }}"##)
    }

    #[test]
    fn says_what_is_wrong() {
        let cases: &[(&str, &str)] = &[
            (r#"[{ "blur": 2 }]"#, "unknown step \"blur\""),
            (r#"[{ "threshold": [0, 1], "keep_largest": 1 }]"#, "one step per object"),
            (r#"[{ "keep_largest": 1, "x": 1 }]"#, "unknown field \"x\""),
            (r#"[{ "inside": "b" }]"#, "\"b\" is not a structure built before"),
            (r#"[{ "inside": "zzz" }]"#, "\"zzz\" is not a structure"),
            (r#"[{ "inside": "a", "dilate_mm": -1 }]"#, "dilate_mm is a number from 0"),
            (r#"[{ "threshold": [null, null] }]"#, "at least one end"),
            (r#"[{ "threshold": [5, 1] }]"#, "low end is above"),
            (r#"[{ "threshold": [0] }]"#, "threshold is [lo, hi]"),
            (r#"[{ "keep_largest": 0 }]"#, "keep_largest is a whole number"),
            (r#"[{ "keep_largest": 1.5 }]"#, "keep_largest is a whole number"),
            (r#"[{ "fill_holes": false }]"#, "fill_holes is true"),
            (r#"[{ "dilate_mm": 0 }]"#, "dilate_mm is a number above 0"),
            (r#"[{ "threshold": [0, null] }, { "from": "a" }]"#, "first step only"),
            (r#"[{ "split_side": "left" }]"#, "split_side is"),
            (r#"[{ "connected_to_seed": "lungs" }]"#, "connected_to_seed is"),
            (r#"[{ "region_grow": { "seed": [1, 2], "range": [0, 1] } }]"#, "seed is [x, y, z]"),
            (r#"[{ "region_grow": { "seed": [1, 2, 3], "range": [0, 1], "limit": 5 } }]"#, "unknown field \"limit\""),
            (r#"[]"#, "steps: is empty"),
            (r#"[ 3 ]"#, "a step is an object"),
        ];
        for (steps, want) in cases {
            let e = err(&one(steps));
            assert!(e.contains(want), "{steps}: {e}");
            assert!(e.starts_with("structures[1].steps"), "{steps}: {e}");
        }
        assert!(err(r#"{ "structures": [], "extra": 1 }"#).contains("unknown field `extra`"));
        assert!(err(r#"{ "structures": [] }"#).contains("structures: is empty"));
        assert!(err(r#"{ "profile": { "units": "HU" }, "structures": [] }"#).contains("unknown field `units`"));
        assert!(err(r##"{ "profile": { "windows": { "w": [0, 1] } }, "structures": [] }"##).contains("width must be positive"));
        assert!(err(r##"{ "profile": { "orientation": "up" }, "structures": [] }"##).contains("orientation"));
        let s = |extra: &str| format!(r##"{{ "structures": [ {{ "id": "a", "name": "A", "color": "#000000", {extra} "steps": [ {{ "threshold": [0, null] }} ] }} ] }}"##);
        assert!(err(&s(r#""opacity": 2,"#)).contains("opacity"));
        assert!(err(&s(r#""shape": 2,"#)).contains("unknown field `shape`"));
        assert!(err(&s("").replace("#000000", "red")).contains("color"));
        assert!(err(&s("").replace("\"a\"", "\"A B\"")).contains("id"));
        assert!(err(r##"{ "structures": [ { "id": "a", "name": "A", "color": "#000000", "steps": [ { "threshold": [0, null] } ] }, { "id": "a", "name": "A", "color": "#000000", "steps": [ { "threshold": [0, null] } ] } ] }"##).contains("used twice"));
    }
}
