fn main() {
    // Tell Cargo to re-run build.rs when these files change.
    // Without these directives, Cargo caches the brotli-compressed frontend blob
    // and silently skips frontend changes — requiring `cargo clean` before every rebuild.
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=frontend/index.html");
    println!("cargo:rerun-if-changed=frontend/app.js");
    println!("cargo:rerun-if-changed=frontend/styles.css");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    // Embed package version into the frontend at build time
    let pkg_path = std::path::Path::new("../package.json");
    if let Ok(contents) = std::fs::read_to_string(pkg_path) {
        if let Some(version) = serde_json::from_str::<serde_json::Value>(&contents)
            .ok()
            .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from))
        {
            println!("cargo:rustc-env=PACKAGE_VERSION={version}");
        }
    }
    tauri_build::build()
}
