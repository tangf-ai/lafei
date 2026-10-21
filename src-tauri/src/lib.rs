use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

mod logseq;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_WRITE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    path: String,
    content: String,
    modified_ms: u64,
}

fn allowed_store_path(relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.len() > 512 {
        return Err("文件路径为空或过长".into());
    }

    let path = Path::new(relative);
    if path.is_absolute() {
        return Err("不允许绝对路径".into());
    }

    let mut components = path.components();
    let first = match components.next() {
        Some(Component::Normal(value)) => value.to_string_lossy().to_string(),
        _ => return Err("非法文件路径".into()),
    };

    if matches!(
        first.as_str(),
        "manifest.json" | "tombstones.json" | "README.md"
    ) {
        if components.next().is_some() {
            return Err("非法文件路径".into());
        }
        return Ok(path.to_path_buf());
    }

    let expected_extension = match first.as_str() {
        "notes" => ".md",
        "tasks" | "chats" => ".json",
        _ => return Err("不允许写入该目录".into()),
    };

    let name = match components.next() {
        Some(Component::Normal(value)) => value.to_string_lossy().to_string(),
        _ => return Err("缺少文件名".into()),
    };
    if components.next().is_some() {
        return Err("不允许嵌套目录".into());
    }
    if name.starts_with('.') || name.contains('/') || name.contains('\\') {
        return Err("非法文件名".into());
    }
    if !name.ends_with(expected_extension) {
        return Err(format!("文件必须使用 {expected_extension} 扩展名"));
    }

    Ok(path.to_path_buf())
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn read_one(root: &Path, relative: &str) -> Result<Option<StoreFile>, String> {
    let relative_path = allowed_store_path(relative)?;
    let path = root.join(&relative_path);
    if !path.is_file() {
        return Ok(None);
    }
    let metadata =
        fs::metadata(&path).map_err(|error| format!("无法读取 {relative} 的信息：{error}"))?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!("{relative} 超过 16MB，已停止同步以保护数据"));
    }
    let content = fs::read_to_string(&path).map_err(|error| {
        format!("无法读取 {relative}（可能正在从 iCloud 下载），请稍后重试：{error}")
    })?;
    Ok(Some(StoreFile {
        path: relative_path.to_string_lossy().replace('\\', "/"),
        content,
        modified_ms: modified_ms(&path),
    }))
}

fn read_store_files_impl(root: &str) -> Result<Vec<StoreFile>, String> {
    let root = Path::new(root);
    if !root.is_dir() {
        return Err("找不到数据文件夹，请重新选择".into());
    }

    let mut files = Vec::new();
    for name in ["manifest.json", "tombstones.json"] {
        if let Some(file) = read_one(root, name)? {
            files.push(file);
        }
    }

    for directory in ["notes", "tasks", "chats"] {
        let path = root.join(directory);
        if !path.is_dir() {
            continue;
        }
        let expected_extension = if directory == "notes" { "md" } else { "json" };
        let mut entries: Vec<_> = fs::read_dir(&path)
            .map_err(|error| format!("读取 {directory} 失败：{error}"))?
            .filter_map(Result::ok)
            .collect();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if file_name.starts_with('.') || !file_name.ends_with(&format!(".{expected_extension}"))
            {
                continue;
            }
            let relative = format!("{directory}/{file_name}");
            if let Some(file) = read_one(root, &relative)? {
                files.push(file);
            }
        }
    }

    Ok(files)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| "非法文件名".to_string())?;
    let temp_path = path.with_file_name(format!(".{file_name}.lafei-tmp"));
    fs::write(&temp_path, contents).map_err(|error| format!("写入临时文件失败：{error}"))?;
    #[cfg(target_os = "windows")]
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("替换旧文件失败：{error}"))?;
    }
    fs::rename(&temp_path, path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!("保存文件失败：{error}")
    })
}

fn write_store_file_impl(root: &str, relative: &str, contents: &str) -> Result<(), String> {
    if contents.len() > MAX_WRITE_BYTES {
        return Err("文件过大，超过 32MB 限制".into());
    }
    let root = Path::new(root);
    if !root.is_dir() {
        return Err("找不到数据文件夹，请重新选择".into());
    }
    let relative_path = allowed_store_path(relative)?;
    atomic_write(&root.join(relative_path), contents.as_bytes())
}

fn read_store_manifest_impl(root: &str) -> Result<Option<String>, String> {
    let root = Path::new(root);
    let path = root.join("manifest.json");
    if !path.is_file() {
        return Ok(None);
    }
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > 1024 * 1024 {
        return Ok(None);
    }
    fs::read_to_string(path)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn prepare_store_impl(selected: &str) -> Result<String, String> {
    let selected = Path::new(selected);
    if !selected.is_dir() {
        return Err("请选择一个已经存在的文件夹".into());
    }

    let selected_is_store = fs::read_to_string(selected.join("manifest.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| {
            json.get("app")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        })
        .as_deref()
        == Some("lafei");
    let named_lafei = selected
        .file_name()
        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("lafei"))
        .unwrap_or(false);

    let root = if selected_is_store || named_lafei {
        selected.to_path_buf()
    } else {
        selected.join("Lafei")
    };

    for directory in ["notes", "tasks", "chats"] {
        fs::create_dir_all(root.join(directory))
            .map_err(|error| format!("创建目录失败：{error}"))?;
    }

    let readme = root.join("README.md");
    if !readme.exists() {
        fs::write(
            &readme,
            "# Lafei 数据文件夹\n\n这个文件夹由 Lafei 自动管理，可以通过 iCloud Drive、坚果云或任意同步盘在多台设备之间同步。\n\n- `notes/`：每篇笔记，Markdown 正文 + YAML 元数据\n- `tasks/`：任务数据\n- `chats/`：AI 对话数据\n- `tombstones.json`：删除记录，用于跨设备同步\n- `manifest.json`：同步元信息\n\n建议在 Lafei 应用内编辑。请定期备份整个文件夹。\n",
        )
        .map_err(|error| format!("写入说明文件失败：{error}"))?;
    }

    Ok(root.to_string_lossy().to_string())
}

fn clear_store_data_impl(root: &str) -> Result<(), String> {
    let root = Path::new(root);
    if !root.is_dir() {
        return Err("找不到数据文件夹".into());
    }
    for directory in ["notes", "tasks", "chats"] {
        let path = root.join(directory);
        if !path.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&path)
            .map_err(|error| format!("读取 {directory} 失败：{error}"))?
            .filter_map(Result::ok)
        {
            if entry.path().is_file() {
                fs::remove_file(entry.path()).map_err(|error| error.to_string())?;
            }
        }
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    }
    for name in ["tombstones.json", "manifest.json"] {
        let path = root.join(name);
        if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn pick_store_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(path) => path
            .into_path()
            .map(|path| Some(path.to_string_lossy().to_string()))
            .map_err(|error| error.to_string()),
        None => Ok(None),
    }
}

#[tauri::command]
async fn prepare_store(selected: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_store_impl(&selected))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_store_files(root: String) -> Result<Vec<StoreFile>, String> {
    tauri::async_runtime::spawn_blocking(move || read_store_files_impl(&root))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_store_manifest(root: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || read_store_manifest_impl(&root))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn write_store_file(root: String, path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_store_file_impl(&root, &path, &contents))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn remove_store_file(root: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root_path = Path::new(&root);
        let relative = allowed_store_path(&path)?;
        let target = root_path.join(relative);
        if target.exists() {
            fs::remove_file(target).map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_store_data(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clear_store_data_impl(&root))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_text_file(
    app: tauri::AppHandle,
    filename: String,
    contents: String,
    kind: String,
) -> Result<Option<String>, String> {
    let (label, extensions): (&str, &[&str]) = if kind == "json" {
        ("JSON", &["json"])
    } else {
        ("Markdown", &["md"])
    };

    let file_path = app
        .dialog()
        .file()
        .set_file_name(filename)
        .add_filter(label, extensions)
        .blocking_save_file();

    match file_path {
        Some(path) => {
            let path = path.into_path().map_err(|error| error.to_string())?;
            fs::write(&path, contents).map_err(|error| error.to_string())?;
            Ok(Some(path.display().to_string()))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_expected_store_paths() {
        for path in [
            "manifest.json",
            "tombstones.json",
            "README.md",
            "notes/2f1c.md",
            "tasks/2f1c.json",
            "chats/2f1c.json",
        ] {
            assert!(allowed_store_path(path).is_ok(), "{path} should be allowed");
        }
    }

    #[test]
    fn rejects_unsafe_store_paths() {
        for path in [
            "",
            "../secrets",
            "notes/../x.md",
            "notes/a.json",
            "tasks/a.md",
            "notes/nested/a.md",
            "notes/.hidden.md",
            "other/a.md",
            "/etc/passwd",
        ] {
            assert!(
                allowed_store_path(path).is_err(),
                "{path} should be rejected"
            );
        }
    }

    #[test]
    fn parses_ai_response_helpers() {
        let value: Value =
            serde_json::from_str(r#"{"choices":[{"message":{"content":"hello"}}]}"#).unwrap();
        assert_eq!(ai_content_from_json(&value).as_deref(), Some("hello"));
        assert_eq!(ai_error_from_json(&value), None);
        assert_eq!(
            ai_body_detail(r#"{"error":{"message":"bad key"}}"#),
            "bad key"
        );
    }

    #[test]
    fn validates_ai_endpoint_scheme() {
        let request = AiRequest {
            id: "test".into(),
            endpoint: "file:///etc/passwd".into(),
            api_key: String::new(),
            model: "mock".into(),
            messages: Vec::new(),
            temperature: 0.0,
            max_tokens: 10,
        };
        let client = ai_client().unwrap();
        assert!(ai_request_builder(&client, &request, false).is_err());
    }

    #[test]
    fn roundtrips_files_in_store() {
        let root = std::env::temp_dir().join(format!("lafei-store-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let selected = prepare_store_impl(root.to_str().unwrap()).unwrap();
        let selected_path = PathBuf::from(&selected);
        assert!(selected_path.join("notes").is_dir());

        write_store_file_impl(&selected, "notes/test.md", "hello").unwrap();
        let files = read_store_files_impl(&selected).unwrap();
        assert!(files
            .iter()
            .any(|file| file.path == "notes/test.md" && file.content == "hello"));

        clear_store_data_impl(&selected).unwrap();
        let files = read_store_files_impl(&selected).unwrap();
        assert!(files.is_empty());

        let _ = fs::remove_dir_all(&root);
    }
}

#[derive(Default)]
struct AiCancelState {
    requests: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AiCancelState {
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut requests) = self.requests.lock() {
            requests.insert(id.to_string(), flag.clone());
        }
        flag
    }

    fn cancel(&self, id: &str) {
        if let Ok(requests) = self.requests.lock() {
            if let Some(flag) = requests.get(id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    fn clear(&self, id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(id);
        }
    }
}

static AI_CANCELS: OnceLock<AiCancelState> = OnceLock::new();

fn ai_cancels() -> &'static AiCancelState {
    AI_CANCELS.get_or_init(AiCancelState::default)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AiMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiRequest {
    id: String,
    endpoint: String,
    api_key: String,
    model: String,
    messages: Vec<AiMessage>,
    temperature: f32,
    max_tokens: u32,
}

fn ai_body_detail(text: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        for pointer in ["/error/message", "/message"] {
            if let Some(message) = value.pointer(pointer).and_then(Value::as_str) {
                return message.chars().take(300).collect();
            }
        }
        if let Some(message) = value.get("error").and_then(Value::as_str) {
            return message.chars().take(300).collect();
        }
    }
    text.chars().take(300).collect()
}

fn ai_network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "NETWORK: 请求超时，请检查接口地址、网络或代理设置".into()
    } else if error.is_connect() {
        format!("NETWORK: 无法建立连接（{error}）")
    } else {
        format!("NETWORK: {error}")
    }
}

fn ai_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| format!("CONFIG: 初始化网络客户端失败：{error}"))
}

fn ai_request_builder(
    client: &reqwest::Client,
    request: &AiRequest,
    stream: bool,
) -> Result<reqwest::RequestBuilder, String> {
    let url = reqwest::Url::parse(&request.endpoint)
        .map_err(|_| "CONFIG: 接口地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("CONFIG: 接口地址只支持 http 或 https".into());
    }

    let mut builder = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(
            reqwest::header::ACCEPT,
            if stream {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .json(&json!({
            "model": request.model,
            "messages": request.messages,
            "temperature": request.temperature,
            "max_tokens": request.max_tokens,
            "stream": stream,
        }));

    if !request.api_key.trim().is_empty() {
        builder = builder.bearer_auth(request.api_key.trim());
    }

    Ok(builder)
}

async fn ai_send_request(request: &AiRequest, stream: bool) -> Result<reqwest::Response, String> {
    let client = ai_client()?;
    let builder = ai_request_builder(&client, request, stream)?;
    let response = builder.send().await.map_err(ai_network_error)?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            ai_body_detail(&body)
        ));
    }
    Ok(response)
}

fn ai_content_from_json(value: &Value) -> Option<String> {
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn ai_error_from_json(value: &Value) -> Option<String> {
    let error = value.get("error")?;
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    if let Some(message) = error.as_str() {
        return Some(message.to_string());
    }
    Some("AI 服务返回了一个错误".into())
}

fn ai_handle_sse_line(
    line: &str,
    channel: &Channel<String>,
    full: &mut String,
) -> Result<(), String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("data:") {
        return Ok(());
    }
    let data = trimmed[5..].trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    let value: Value = match serde_json::from_str(data) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    if let Some(message) = ai_error_from_json(&value) {
        return Err(format!("SERVER: {message}"));
    }
    if let Some(content) = value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
        })
    {
        if !content.is_empty() {
            full.push_str(content);
            channel
                .send(content.to_string())
                .map_err(|error| format!("CHANNEL: 无法回传 AI 响应：{error}"))?;
        }
    }
    Ok(())
}

async fn ai_stream_inner(
    request: &AiRequest,
    channel: &Channel<String>,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("CANCELLED".into());
    }

    let response = ai_send_request(request, true).await?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if content_type.contains("application/json") && !content_type.contains("event-stream") {
        let text = response.text().await.map_err(ai_network_error)?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|_| format!("SERVER: 无法解析 AI 响应：{}", ai_body_detail(&text)))?;
        if let Some(message) = ai_error_from_json(&value) {
            return Err(format!("SERVER: {message}"));
        }
        if let Some(content) = ai_content_from_json(&value) {
            channel
                .send(content)
                .map_err(|error| format!("CHANNEL: {error}"))?;
            return Ok(());
        }
        return Err("EMPTY: AI 没有返回文字".into());
    }

    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    let mut full = String::new();

    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::SeqCst) {
            return Err("CANCELLED".into());
        }
        let chunk = chunk.map_err(ai_network_error)?;
        pending.extend_from_slice(&chunk);

        while let Some(index) = pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = pending.drain(..=index).collect();
            ai_handle_sse_line(&String::from_utf8_lossy(&line), channel, &mut full)?;
        }
    }

    if !pending.is_empty() {
        ai_handle_sse_line(&String::from_utf8_lossy(&pending), channel, &mut full)?;
    }

    if full.trim().is_empty() {
        return Err("EMPTY: AI 没有返回文字，请换一个模型或稍后再试".into());
    }
    Ok(())
}

#[tauri::command]
async fn ai_stream(request: AiRequest, channel: Channel<String>) -> Result<(), String> {
    let cancelled = ai_cancels().register(&request.id);
    let result = ai_stream_inner(&request, &channel, &cancelled).await;
    ai_cancels().clear(&request.id);
    result
}

#[tauri::command]
async fn ai_complete(request: AiRequest) -> Result<String, String> {
    let cancelled = ai_cancels().register(&request.id);
    let result = async {
        if cancelled.load(Ordering::SeqCst) {
            return Err("CANCELLED".to_string());
        }
        let response = ai_send_request(&request, false).await?;
        let text = response.text().await.map_err(ai_network_error)?;
        if cancelled.load(Ordering::SeqCst) {
            return Err("CANCELLED".into());
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|_| format!("SERVER: 无法解析 AI 响应：{}", ai_body_detail(&text)))?;
        if let Some(message) = ai_error_from_json(&value) {
            return Err(format!("SERVER: {message}"));
        }
        ai_content_from_json(&value)
            .filter(|content| !content.trim().is_empty())
            .ok_or_else(|| "EMPTY: AI 没有返回文字，请换一个模型或稍后再试".to_string())
    }
    .await;
    ai_cancels().clear(&request.id);
    result
}

#[tauri::command]
fn ai_cancel(id: String) {
    ai_cancels().cancel(&id);
}

#[tauri::command]
async fn scan_logseq_tasks(path: String, today: String) -> Result<logseq::LogseqScan, String> {
    tauri::async_runtime::spawn_blocking(move || logseq::scan(&path, &today))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            save_text_file,
            pick_store_folder,
            prepare_store,
            read_store_files,
            read_store_manifest,
            write_store_file,
            remove_store_file,
            clear_store_data,
            ai_stream,
            ai_complete,
            ai_cancel,
            scan_logseq_tasks
        ])
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building Lafei");

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
    });
}
