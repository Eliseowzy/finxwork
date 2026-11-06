//! A deck as the agent reads it (presentation-ai-design §7): one record a slide, with its text,
//! notes and objects, taken from the engine snapshot. Positions are points from the slide's top
//! left, like the deck protocol.

use betteroffice_pptx::{DeckSnapshot, ShapeKind, ShapeSnapshot, SlideSnapshot};

/// EMU in a point.
const EMU_PER_PT: f64 = 12_700.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Outline {
    pub width_pt: f64,
    pub height_pt: f64,
    pub slides: Vec<SlideOutline>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SlideOutline {
    /// From 1, as people count.
    pub index: usize,
    pub slide_id: String,
    pub title: Option<String>,
    pub layout: Option<String>,
    pub hidden: bool,
    pub notes: String,
    pub objects: Vec<ObjectOutline>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ObjectOutline {
    pub shape_id: String,
    pub name: String,
    /// `title`, `text_box`, `shape`, `picture`, `table`, `chart`, `diagram`, `graphic`, `group`.
    pub kind: &'static str,
    /// The layout placeholder it fills (`title`, `body`, `ctrTitle`…).
    pub placeholder: Option<String>,
    /// x, y, width, height in points.
    pub rect: [f64; 4],
    pub text: String,
    /// A table's cells, row by row, when its stories line up with its grid.
    pub table: Option<Vec<Vec<String>>>,
    /// Alternative text of pictures and charts.
    pub alt: Option<String>,
    pub depth: usize,
}

impl SlideOutline {
    pub fn has(&self, kind: &str) -> bool {
        self.objects.iter().any(|o| o.kind == kind)
    }
}

pub fn outline(deck: &DeckSnapshot) -> Outline {
    Outline {
        width_pt: deck.width_emu as f64 / EMU_PER_PT,
        height_pt: deck.height_emu as f64 / EMU_PER_PT,
        slides: deck.slides.iter().enumerate().map(|(i, s)| slide(i + 1, s)).collect(),
    }
}

fn slide(index: usize, s: &SlideSnapshot) -> SlideOutline {
    let mut objects = Vec::new();
    for shape in &s.shapes {
        object(shape, 0, &mut objects);
    }
    let title = s
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| objects.iter().find(|o| o.kind == "title" && !o.text.trim().is_empty()).map(|o| o.text.replace('\n', " ")));
    SlideOutline {
        index,
        slide_id: s.id.clone(),
        title,
        layout: s.layout.as_ref().and_then(|l| l.name.clone().or_else(|| l.r#type.clone())),
        hidden: s.hidden == Some(true),
        notes: s.notes.trim().to_owned(),
        objects,
    }
}

fn object(shape: &ShapeSnapshot, depth: usize, out: &mut Vec<ObjectOutline>) {
    let placeholder = shape.placeholder.as_ref().and_then(|p| p.placeholder_type.clone());
    // The slide number, date and the like are the master's furniture, not the slide's content.
    if shape.hidden || matches!(placeholder.as_deref(), Some("sldNum" | "dt")) {
        return;
    }
    let kind = kind(shape, placeholder.as_deref());
    let (x, y, w, h) = shape.inherited.as_ref().map_or((shape.x, shape.y, shape.width, shape.height), |r| (r.x, r.y, r.width, r.height));
    let text = shape
        .text_stories
        .iter()
        .map(|s| s.plain_text())
        .filter(|t| !t.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let table = (kind == "table").then(|| cells(shape)).flatten();
    let alt = [shape.description.as_deref(), shape.title.as_deref()].into_iter().flatten().find(|t| !t.trim().is_empty()).map(str::to_owned);
    out.push(ObjectOutline {
        shape_id: shape.id.clone(),
        name: shape.name.clone(),
        kind,
        placeholder,
        rect: [x, y, w, h].map(|v| (v as f64 / EMU_PER_PT * 10.0).round() / 10.0),
        text,
        table,
        alt,
        depth,
    });
    for child in &shape.children {
        object(child, depth + 1, out);
    }
}

fn kind(shape: &ShapeSnapshot, placeholder: Option<&str>) -> &'static str {
    use betteroffice_pptx::GraphicFrameData;
    match shape.kind {
        ShapeKind::Group => "group",
        ShapeKind::Picture => "picture",
        ShapeKind::GraphicFrame => match &shape.graphic {
            Some(GraphicFrameData::Table(_)) => "table",
            Some(GraphicFrameData::Chart { .. }) => "chart",
            Some(GraphicFrameData::Diagram { .. }) => "diagram",
            _ if shape.table_structure.is_some() => "table",
            _ => "graphic",
        },
        ShapeKind::Shape if matches!(placeholder, Some("title" | "ctrTitle")) => "title",
        ShapeKind::Shape if shape.text_box => "text_box",
        ShapeKind::Shape => "shape",
    }
}

fn cells(shape: &ShapeSnapshot) -> Option<Vec<Vec<String>>> {
    use betteroffice_pptx::GraphicFrameData;
    let cols = match &shape.graphic {
        Some(GraphicFrameData::Table(t)) if !t.grid.is_empty() => t.grid.len(),
        _ => shape.table_structure.as_ref().map(|t| t.grid.len()).filter(|&n| n > 0)?,
    };
    let texts: Vec<String> = shape.text_stories.iter().map(|s| s.plain_text().replace('\n', " ")).collect();
    texts.len().is_multiple_of(cols).then(|| texts.chunks(cols).map(<[String]>::to_vec).collect())
}
