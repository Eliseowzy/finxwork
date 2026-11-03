#![allow(clippy::print_stdout)]

fn main() {
    println!("cargo:rerun-if-changed=catalog/builtin.toml");
    // Keep TOML as the editable source. Convert its syntax once at build time; the runtime
    // deserializes the same typed catalog and merges the user's TOML on every launch.
    let source = std::fs::read_to_string("catalog/builtin.toml").expect("read built-in catalog");
    let catalog: toml::Value = toml::from_str(&source).expect("parse built-in catalog");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(
        output.join("builtin-catalog.json"),
        serde_json::to_vec(&catalog).expect("catalog JSON"),
    )
    .expect("write compiled catalog");
}
