//! Writes every formula's computed result into a workbook that was never calculated (files made
//! by xlsxwriter hold 0 for every formula), as Excel would have saved it. For test fixtures:
//! `cargo run -p finx-sheet --example settle -- <in.xlsx> <out.xlsx>`.

use finx_sheet::Cached;
use finx_sheet::CellEdit;
use finx_sheet::NewValue;
use finx_sheet::Options;
use finx_sheet::book::Book;
use finx_sheet::book::Value;
use finx_sheet::calc::Engine;
use finx_sheet::formula::is_excel_error;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).unwrap();
    let e = Engine::new(Book::open(&bytes).unwrap()).unwrap();
    let mut edits = Vec::new();
    for (s, sheet) in e.book.sheets.iter().enumerate() {
        for at in sheet.formulas.keys() {
            if e.constants().contains(&(s, *at))
                || e.book.cell(s, *at).is_some_and(|c| c.has_metadata)
            {
                continue;
            }
            let value = match e.value((s, *at)) {
                Value::Number(v) => Cached::Number(v),
                Value::Text(v) => Cached::Text(v),
                Value::Bool(v) => Cached::Bool(v),
                Value::Error(v) if is_excel_error(&v) => Cached::Error(v),
                Value::Error(_) => continue,
                Value::Empty => Cached::Text(String::new()),
            };
            edits.push(CellEdit {
                sheet: sheet.name.clone(),
                cell: at.to_string(),
                value: NewValue::Result { value },
            });
        }
    }
    let out = finx_sheet::write(&bytes, &edits, &Options::default()).unwrap();
    std::fs::write(&a[2], out.bytes).unwrap();
}
