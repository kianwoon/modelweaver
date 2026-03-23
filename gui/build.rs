fn main() {
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
