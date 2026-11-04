//! The calculation agrees with Excel (design §5.6, §13.1): on files Excel saved, every formula
//! we compute equals the value Excel stored; functions finance models use match their
//! reference values; real models with circular references settle where Excel did.

use std::path::Path;
use std::path::PathBuf;

use finx_sheet::NewValue;
use finx_sheet::book::Book;
use finx_sheet::book::Value;
use finx_sheet::calc::Engine;
use finx_sheet::cellref::CellRef;

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn engine(path: &Path) -> Engine {
    Engine::new(Book::open(&std::fs::read(path).unwrap()).unwrap()).unwrap()
}

/// Formula cells whose computed value differs from the stored one.
fn disagreements(e: &Engine) -> Vec<String> {
    let mut out = Vec::new();
    for (s, sheet) in e.book.sheets.iter().enumerate() {
        for at in sheet.formulas.keys() {
            let (ours, excel) = (e.value((s, *at)), e.book.value(s, *at));
            if !ours.close_to(&excel, 1e-9) {
                out.push(format!(
                    "{}!{at}: Excel {excel:?}, ours {ours:?}",
                    sheet.name
                ));
            }
        }
    }
    out
}

/// Files saved by Excel whose formulas hold no volatile function, cycle or external link.
#[test]
fn agrees_with_excel_on_saved_files() {
    for name in [
        "column_row_ranges.xlsx",
        "formula_range_without_column_component.xlsx",
        "non_ascii_shared_formula.xlsx",
        "non_monotonic_si.xlsx",
        "pivots.xlsx",
        "shared_formula_bench.xlsx",
        "shared_formula_dragged.xlsx",
        "shared_formula_function_names.xlsx",
        "shared_formula_reversed.xlsx",
        "shared_formula_simple.xlsx",
        "issues.xlsx",
        "string-ref.xlsx",
    ] {
        let e = engine(&fixture(name));
        let bad = disagreements(&e);
        assert!(bad.is_empty(), "{name}: {bad:?}");
    }
}

/// `gen/funcs.xlsx`: column B a function, column C its reference value (computed from the
/// function's definition, not by Excel). Two known gaps in IronCalc 0.9: AGGREGATE, and
/// TEXTJOIN's ignore-empty argument (design §5.6.1).
#[test]
fn finance_functions_match_reference_values() {
    let e = engine(&fixture("gen/funcs.xlsx"));
    let s = e.book.sheet_index("Funcs").unwrap();
    let (mut ok, mut wrong) = (0, Vec::new());
    for row in 1.. {
        let Value::Text(name) = e.book.value(s, CellRef::new(row, 1)) else {
            break;
        };
        let want = e.book.value(s, CellRef::new(row, 3));
        if want == Value::Empty {
            continue;
        }
        let got = e.value((s, CellRef::new(row, 2)));
        if got.close_to(&want, 1e-6) {
            ok += 1;
        } else {
            wrong.push(name);
        }
    }
    assert_eq!(wrong, ["AGGREGATE", "TEXTJOIN"]);
    assert!(ok >= 68, "{ok}");
}

/// A cycle on a workbook that iterates: x = 0.5·x + 1 settles at 2.
#[test]
fn a_cycle_settles() {
    let mut e = engine(&fixture("gen/funcs.xlsx"));
    let s = e.book.sheet_index("Data").unwrap();
    e.book.info.calc.iterate = true;
    let (a, b) = (CellRef::parse("K1").unwrap(), CellRef::parse("K2").unwrap());
    let impact = e
        .apply(&[
            (
                (s, a),
                NewValue::Formula {
                    text: "=K2*0.5+1".into(),
                    cached: None,
                },
            ),
            (
                (s, b),
                NewValue::Formula {
                    text: "=K1".into(),
                    cached: None,
                },
            ),
        ])
        .unwrap();
    assert!(impact.converged, "{impact:?}");
    assert!(impact.iterations.is_some());
    assert!(
        e.value((s, a)).close_to(&Value::Number(2.0), 1e-9),
        "{:?}",
        e.value((s, a))
    );
    assert!(e.value((s, b)).close_to(&Value::Number(2.0), 1e-9));
}

/// Real models from `FINX_SHEET_CORPUS` (kept out of the repository): every formula, cycles
/// included, equals what Excel saved; started from 0 the cycles settle at the same values.
#[test]
fn real_models_agree_with_excel() {
    let Some(dir) = std::env::var_os("FINX_SHEET_CORPUS") else {
        return;
    };
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| Some(e.ok()?.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "xlsx" || x == "xlsm"))
        .collect();
    files.sort();
    for path in files {
        let mut e = engine(&path);
        let formulas: usize = e.book.sheets.iter().map(|s| s.formulas.len()).sum();
        // Not vacuous: real formulas, computed (not held as stored values), cycles cut.
        assert!(
            formulas > 500 && e.constants().len() * 100 < formulas,
            "{}: {formulas} formulas, {} constants",
            path.display(),
            e.constants().len()
        );
        assert!(
            !e.cut().is_empty() && e.iterations.is_some(),
            "{}: no cycles",
            path.display()
        );
        let bad = disagreements(&e);
        assert!(
            bad.is_empty(),
            "{}: {} differ, e.g. {:?}",
            path.display(),
            bad.len(),
            &bad[..bad.len().min(3)]
        );
        e.recalc_cycles_from_zero().unwrap();
        let bad = disagreements(&e);
        assert!(
            bad.is_empty(),
            "{} from 0: {:?}",
            path.display(),
            &bad[..bad.len().min(3)]
        );
    }
}
