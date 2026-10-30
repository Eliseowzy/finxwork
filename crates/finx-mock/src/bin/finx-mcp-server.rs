//! `finx-mcp-server [options]`: the scriptable MCP test server (see `finx_mock::mcp`).
//!
//! Options: `--name NAME`, `--instructions TEXT`, `--tools N` (generated tools),
//! `--domain NAME` (only that domain's generated tools), `--page-size N`, `--log PATH`, `--stderr-lines N` (noise on stderr at start-up),
//! `--http ADDR` (Streamable HTTP instead of stdio; prints the URL).

use finx_mock::mcp::McpTestOptions;
use std::io::Write;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::io::Result<()> {
    let mut options = McpTestOptions {
        own_process: true,
        ..Default::default()
    };
    let mut http: Option<String> = None;
    let mut stderr_lines = 0usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().unwrap_or_default();
        match arg.as_str() {
            "--name" => options.name = value(),
            "--instructions" => options.instructions = Some(value()).filter(|v| !v.is_empty()),
            "--tools" => options.generated = value().parse().unwrap_or(0),
            "--domain" => options.domain = Some(value()),
            "--page-size" => options.page_size = value().parse().unwrap_or(0),
            "--log" => options.log = Some(value().into()),
            "--stderr-lines" => stderr_lines = value().parse().unwrap_or(0),
            "--http" => http = Some(value()),
            _ => {}
        }
    }
    let mut err = std::io::stderr().lock();
    for n in 0..stderr_lines {
        writeln!(err, "noise line {n} from the test server, long enough to fill a pipe buffer quickly")?;
    }
    drop(err);
    match http {
        Some(addr) => {
            let server = finx_mock::mcp::serve_http(&addr, options).await?;
            let mut out = std::io::stdout().lock();
            writeln!(out, "{}", server.url())?;
            out.flush()?;
            drop(out);
            tokio::signal::ctrl_c().await?;
        }
        None => finx_mock::mcp::serve_stdio(tokio::io::stdin(), tokio::io::stdout(), options).await,
    }
    Ok(())
}
