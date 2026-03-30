use std::sync::OnceLock;
use tauri::Manager;
use tauri::Emitter;
use tauri::command;

fn shared_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("Failed to create HTTP client")
    })
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetricsResult {
    uptime_seconds: Option<u64>,
    total_requests: Option<u64>,
    total_input_tokens: Option<u64>,
    total_output_tokens: Option<u64>,
    avg_tokens_per_sec: Option<f64>,
    active_models: Option<Vec<serde_json::Value>>,
    provider_distribution: Option<Vec<serde_json::Value>>,
    recent_requests: Option<Vec<serde_json::Value>>,
    total_cache_read_tokens: Option<u64>,
    total_cache_creation_tokens: Option<u64>,
    avg_cache_hit_rate: Option<f64>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct VersionResult {
    version: String,
}

#[command]
async fn fetch_metrics(port: u16) -> Result<MetricsResult, String> {
    let url = format!("http://localhost:{}/api/metrics/summary", port);

    let resp = shared_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP error: {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    Ok(MetricsResult {
        uptime_seconds: data["uptimeSeconds"].as_u64(),
        total_requests: data["totalRequests"].as_u64(),
        total_input_tokens: data["totalInputTokens"].as_u64(),
        total_output_tokens: data["totalOutputTokens"].as_u64(),
        avg_tokens_per_sec: data["avgTokensPerSec"].as_f64(),
        active_models: data["activeModels"].as_array().cloned(),
        provider_distribution: data["providerDistribution"].as_array().cloned(),
        recent_requests: data["recentRequests"].as_array().cloned(),
        total_cache_read_tokens: data["totalCacheReadTokens"].as_u64(),
        total_cache_creation_tokens: data["totalCacheCreationTokens"].as_u64(),
        avg_cache_hit_rate: data["avgCacheHitRate"].as_f64(),
    })
}

#[command]
async fn check_daemon(port: u16) -> Result<bool, String> {
    let url = format!("http://localhost:{}/api/metrics/summary", port);

    match shared_client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[command]
async fn fetch_version(port: u16) -> Result<VersionResult, String> {
    let url = format!("http://localhost:{}/api/version", port);
    let resp = shared_client().get(&url).send().await.map_err(|e| format!("HTTP request failed: {}", e))?;
    if !resp.status().is_success() { return Err(format!("HTTP error: {}", resp.status())); }
    let data: serde_json::Value = resp.json().await.map_err(|e| format!("Failed to parse JSON: {}", e))?;
    Ok(VersionResult { version: data["version"].as_str().unwrap_or("unknown").to_string() })
}

pub fn run() {
    let version = env!("PACKAGE_VERSION");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![fetch_metrics, check_daemon, fetch_version])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title(&format!("ModelWeaver v{}", version)).unwrap();
            window.emit("version-update", version).unwrap();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
