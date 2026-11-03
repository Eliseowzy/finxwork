//! End-to-end: documents over the native protocol (document-editor-design §6), with the real
//! `finx doc-worker` behind `finx serve` and PDFium (tools/pdfium, see crates/finx-docs).

mod common;

use common::SchemaCheck;
use common::TestEnv;
use serde_json::json;
use std::path::Path;

/// A PDF of `pages`, each a list of (x, y, size, text) in Helvetica.
fn write_pdf(path: &Path, pages: &[Vec<(f32, f32, f32, &str)>]) {
    let mut objects: Vec<String> = vec!["<< /Type /Catalog /Pages 2 0 R >>".into()];
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
    objects.push(format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()));
    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into());
    for (i, lines) in pages.iter().enumerate() {
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>", 5 + i * 2));
        let stream: String = lines.iter().map(|(x, y, size, text)| format!("BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n")).collect();
        objects.push(format!("<< /Length {} >>\nstream\n{stream}endstream", stream.len()));
    }
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{body}\nendobj\n", i + 1).bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for o in offsets {
        out.extend(format!("{o:010} 00000 n \n").bytes());
    }
    out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).bytes());
    std::fs::write(path, out).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_document_opens_reads_and_closes_over_the_protocol() {
    let env = TestEnv::new("manual", "").await;
    let schema = SchemaCheck::new(&["DocOpenResult", "DocResolveResult", "DocLocateResult"]);
    let (_child, client, _incoming) = env.spawn_rpc(&["serve", "--stdio"]);
    client.request("initialize", json!({"protocol_version": 2, "client_info": {"name": "e2e"}})).await.unwrap();
    let cwd = env.workspace("a");
    let created = client.request("session/new", json!({"cwd": cwd})).await.unwrap();
    let session = created["session_id"].as_str().unwrap().to_string();
    let file = cwd.join("report.pdf");
    write_pdf(
        &file,
        &[
            vec![(50.0, 720.0, 24.0, "Annual Report"), (50.0, 100.0, 11.0, "Revenue grew 12.5% to")],
            vec![(50.0, 700.0, 11.0, "3.2 billion this year.")],
        ],
    );

    let opened = client.request("doc/open", json!({"session_id": session, "path": file})).await.unwrap();
    schema.check("DocOpenResult", &opened);
    assert_eq!(opened["info"]["pages"], 2);
    let doc_id = opened["info"]["doc_id"].as_str().unwrap().to_string();
    let token = opened["token"].as_str().unwrap();
    // The app finds the document by its token, under the home.
    assert_eq!(std::fs::read_to_string(env.home.path().join("docs/.tokens").join(token)).unwrap(), doc_id);

    // A selection from the end of page 1 into page 2: one text, an anchor a page.
    let resolved = client
        .request(
            "doc/resolve",
            json!({
                "session_id": session, "doc_id": doc_id,
                "page": 1, "quads": [{"x0": 40, "y0": 95, "x1": 400, "y1": 115}],
                "more": [{"page": 2, "quads": [{"x0": 40, "y0": 695, "x1": 400, "y1": 715}]}],
            }),
        )
        .await
        .unwrap();
    schema.check("DocResolveResult", &resolved);
    assert_eq!(resolved["text"], "Revenue grew 12.5% to 3.2 billion this year.");
    assert_eq!(resolved["anchor"]["page"], 1);
    assert_eq!(resolved["more"][0]["anchor"]["page"], 2);
    assert_eq!(resolved["more"][0]["anchor"]["text"], "3.2 billion this year.");
    // Pages must go forward.
    let err = client
        .request("doc/resolve", json!({"session_id": session, "doc_id": doc_id, "page": 2, "quads": [{"x0": 0, "y0": 0, "x1": 1, "y1": 1}], "more": [{"page": 1, "quads": [{"x0": 0, "y0": 0, "x1": 1, "y1": 1}]}]}))
        .await
        .unwrap_err();
    assert_eq!(err.code, finx_rpc::code::INVALID_PARAMS);

    let located = client.request("doc/locate", json!({"session_id": session, "doc_id": doc_id, "target": "p1.b0"})).await.unwrap();
    schema.check("DocLocateResult", &located);
    assert_eq!(located["anchor"]["text"], "Annual Report");
    client.request("doc/view", json!({"session_id": session, "doc_id": doc_id, "page": 2})).await.unwrap();

    // Missing files and files that are not PDFs are said to be so.
    let missing = client.request("doc/open", json!({"session_id": session, "path": cwd.join("nope.pdf")})).await.unwrap_err();
    assert_eq!(missing.code, -32032);
    std::fs::write(cwd.join("notes.pdf"), "not a pdf").unwrap();
    let not_pdf = client.request("doc/open", json!({"session_id": session, "path": cwd.join("notes.pdf")})).await.unwrap_err();
    assert_eq!(not_pdf.code, -32032);

    // Closed by its last session, it opens again by its id (a citation, after a restart).
    client.request("doc/close", json!({"session_id": session, "doc_id": doc_id})).await.unwrap();
    assert!(!env.home.path().join("docs/.tokens").join(token).exists());
    let again = client.request("doc/open", json!({"session_id": session, "doc_id": doc_id})).await.unwrap();
    assert_eq!(again["info"]["path"], json!(std::fs::canonicalize(&file).unwrap()));
}
