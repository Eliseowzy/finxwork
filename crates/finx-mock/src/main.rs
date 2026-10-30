//! `finx-mock [ADDR]`: run the mock model service in the foreground (default 127.0.0.1:0).
//! Prints the base URL and a matching `models.toml`.

use std::io::Write;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> std::io::Result<()> {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:0".to_string());
    let server = finx_mock::MockServer::bind(&addr).await?;
    let mut out = std::io::stdout().lock();
    writeln!(out, "# base_url: {}", server.base_url())?;
    writeln!(out, "{}", server.models_toml())?;
    out.flush()?;
    drop(out);
    tokio::signal::ctrl_c().await?;
    Ok(())
}
