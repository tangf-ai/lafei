use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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

const AGENT_MAX_FILES: usize = 20_000;
const AGENT_MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Deserialize)]
struct AgentFileInput {
    path: String,
    contents: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSnapshotStatus {
    dir: String,
    app_version: String,
    exists: bool,
    modified_at: Option<u64>,
    file_count: usize,
    notes: u64,
    tasks: u64,
    pending_requests: u64,
    mcp_path: String,
    mcp_exists: bool,
}

fn agent_snapshot_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("agent"))
        .map_err(|error| format!("无法定位应用数据目录：{error}"))
}

fn agent_mcp_binary_path() -> String {
    let name = if cfg!(windows) {
        "lafei-mcp.exe"
    } else {
        "lafei-mcp"
    };
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|dir| dir.join(name)))
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}

fn allowed_agent_path(relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() || relative.len() > 512 {
        return Err("智能体快照路径为空或过长".into());
    }
    let path = Path::new(relative);
    if path.is_absolute() {
        return Err("不允许绝对路径".into());
    }
    let mut components = path.components();
    let first = match components.next() {
        Some(Component::Normal(value)) => value.to_string_lossy().to_string(),
        _ => return Err("非法智能体快照路径".into()),
    };

    if matches!(
        first.as_str(),
        "manifest.json" | "AGENTS.md" | "notes.index.json" | "tasks.jsonl" | "tags.json"
    ) {
        if components.next().is_some() {
            return Err("非法智能体快照路径".into());
        }
        return Ok(path.to_path_buf());
    }

    if first != "notes" {
        return Err("不允许写入该智能体快照目录".into());
    }
    let name = match components.next() {
        Some(Component::Normal(value)) => value.to_string_lossy().to_string(),
        _ => return Err("非法笔记文件名".into()),
    };
    if components.next().is_some()
        || name.is_empty()
        || name.len() > 160
        || !name.ends_with(".md")
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err("非法笔记文件名".into());
    }
    Ok(path.to_path_buf())
}

const AGENT_INBOX_MAX_LIST: usize = 100;
const AGENT_INBOX_REQUEST_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const AGENT_INBOX_PROCESSED_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentInboxEntry {
    file: String,
    request_id: String,
    op: String,
    client: Option<String>,
    created_at: u64,
    payload: Value,
}

struct AgentInboxRequest {
    op: String,
    client: Option<String>,
    created_at: u64,
    payload: Value,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// requestId 规则：^[A-Za-z0-9][A-Za-z0-9._-]{7,95}$，且不能包含 `..`、不能以 `.` 开头。
fn valid_agent_request_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(8..=96).contains(&bytes.len()) {
        return false;
    }
    if !bytes[0].is_ascii_alphanumeric() || value.contains("..") {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'-'))
}

/// 校验 inbox 文件名并返回去掉 `.json` 的 requestId。只接受单层文件名，禁止路径分隔符。
fn agent_inbox_request_id_from_file(file: &str) -> Result<&str, String> {
    if file.is_empty() || file.len() > 160 {
        return Err("智能体请求文件名为空或过长".into());
    }
    let mut components = Path::new(file).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return Err("智能体请求文件名不允许包含路径".into());
    }
    if file.starts_with('.') || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("智能体请求文件名无效：只允许单层文件名".into());
    }
    let request_id = file
        .strip_suffix(".json")
        .ok_or_else(|| "智能体请求文件名必须以 .json 结尾".to_string())?;
    if !valid_agent_request_id(request_id) {
        return Err("智能体请求文件名不符合 requestId 规则".into());
    }
    Ok(request_id)
}

fn parse_agent_inbox_request(text: &str) -> Option<AgentInboxRequest> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    let op = object.get("op").and_then(Value::as_str)?.trim().to_string();
    if op.is_empty() {
        return None;
    }
    let created_at = object.get("createdAt").and_then(Value::as_u64)?;
    let client = object
        .get("client")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let payload = object.get("payload").cloned().unwrap_or(Value::Null);
    Some(AgentInboxRequest {
        op,
        client,
        created_at,
        payload,
    })
}

/// 扫描 inbox 目录（不递归），跳过文件名非法、内容无法解析的文件，按 createdAt 升序返回。
fn scan_agent_inbox_entries(inbox: &Path) -> std::io::Result<Vec<AgentInboxEntry>> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(inbox)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file = entry.file_name().to_string_lossy().to_string();
        let request_id = match agent_inbox_request_id_from_file(&file) {
            Ok(request_id) => request_id.to_string(),
            Err(_) => continue,
        };
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(_) => continue,
        };
        let request = match parse_agent_inbox_request(&text) {
            Some(request) => request,
            None => continue,
        };
        entries.push(AgentInboxEntry {
            file,
            request_id,
            op: request.op,
            client: request.client,
            created_at: request.created_at,
            payload: request.payload,
        });
    }
    entries.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.file.cmp(&right.file))
    });
    Ok(entries)
}

fn agent_inbox_entry_expired(path: &Path, now: u64, ttl_ms: u64) -> bool {
    let modified = modified_ms(path);
    modified > 0 && now.saturating_sub(modified) > ttl_ms
}

/// 顺手清理：inbox 里超过 30 天的请求，done/failed 里超过 7 天的结果。失败忽略，不影响列表。
fn cleanup_agent_inbox(dir: &Path, now: u64) {
    let inbox = dir.join("inbox");
    if let Ok(entries) = fs::read_dir(&inbox) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let file = entry.file_name().to_string_lossy().to_string();
            if agent_inbox_request_id_from_file(&file).is_err() {
                continue;
            }
            if agent_inbox_entry_expired(&path, now, AGENT_INBOX_REQUEST_TTL_MS) {
                let _ = fs::remove_file(&path);
            }
        }
    }
    for name in ["done", "failed"] {
        if let Ok(entries) = fs::read_dir(inbox.join(name)) {
            for entry in entries.filter_map(Result::ok) {
                let path = entry.path();
                if path.is_file()
                    && agent_inbox_entry_expired(&path, now, AGENT_INBOX_PROCESSED_TTL_MS)
                {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
}

fn agent_inbox_list_impl(dir: &Path, now: u64) -> Result<Vec<AgentInboxEntry>, String> {
    cleanup_agent_inbox(dir, now);
    let inbox = dir.join("inbox");
    if !inbox.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = scan_agent_inbox_entries(&inbox)
        .map_err(|error| format!("读取智能体请求队列失败：{error}"))?;
    entries.truncate(AGENT_INBOX_MAX_LIST);
    Ok(entries)
}

fn count_agent_inbox_requests(dir: &Path) -> u64 {
    scan_agent_inbox_entries(&dir.join("inbox"))
        .map(|entries| entries.len() as u64)
        .unwrap_or(0)
}

fn agent_inbox_processed_file(done_dir: &Path, failed_dir: &Path, file: &str) -> bool {
    done_dir.join(file).is_file() || failed_dir.join(file).is_file()
}

/// 把请求文件移动到 inbox/done 或 inbox/failed，并把 result 合并进原请求 JSON。
/// 已经结算过的同名请求直接返回 Ok（先结算者生效），保证重复调用幂等。
fn agent_inbox_resolve_impl(
    dir: &Path,
    file: &str,
    status: &str,
    entity_kind: Option<&str>,
    entity_id: Option<&str>,
    title: Option<&str>,
    error: Option<&str>,
    now: u64,
) -> Result<(), String> {
    agent_inbox_request_id_from_file(file)?;
    if !matches!(status, "applied" | "rejected") {
        return Err("智能体请求处理状态只能是 applied 或 rejected".into());
    }
    if let Some(kind) = entity_kind {
        if !matches!(kind, "note" | "task") {
            return Err("智能体请求的实体类型只能是 note 或 task".into());
        }
    }

    let inbox = dir.join("inbox");
    let done_dir = inbox.join("done");
    let failed_dir = inbox.join("failed");
    let source = inbox.join(file);
    let target_dir = if status == "applied" {
        &done_dir
    } else {
        &failed_dir
    };

    // 已经结算过（done 或 failed 有同名文件）就直接返回，并顺手清掉遗留的原始请求文件。
    if agent_inbox_processed_file(&done_dir, &failed_dir, file) {
        let _ = fs::remove_file(&source);
        return Ok(());
    }

    let text = match fs::read_to_string(&source) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if agent_inbox_processed_file(&done_dir, &failed_dir, file) {
                return Ok(());
            }
            return Err(format!("找不到待处理的智能体请求文件：{file}"));
        }
        Err(error) => return Err(format!("读取智能体请求文件失败：{error}")),
    };

    let mut value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("智能体请求文件不是合法的 JSON：{file}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("智能体请求文件不是 JSON 对象：{file}"))?;

    let mut result = serde_json::Map::new();
    result.insert("status".to_string(), Value::String(status.to_string()));
    result.insert("appliedAt".to_string(), json!(now));
    if status == "applied" {
        if let Some(kind) = entity_kind {
            result.insert("entityKind".to_string(), Value::String(kind.to_string()));
        }
        if let Some(id) = entity_id {
            result.insert("entityId".to_string(), Value::String(id.to_string()));
        }
        if let Some(title) = title {
            result.insert("title".to_string(), Value::String(title.to_string()));
        }
    } else if let Some(message) = error {
        result.insert("error".to_string(), Value::String(message.to_string()));
    }
    object.insert("result".to_string(), Value::Object(result));

    let contents = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("生成智能体请求结果失败：{error}"))?;
    write_agent_file_atomic(&target_dir.join(file), contents.as_bytes())?;

    match fs::remove_file(&source) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除已处理的智能体请求文件失败：{error}")),
    }
}

fn read_agent_manifest(root: &Path) -> Option<Value> {
    let text = fs::read_to_string(root.join("manifest.json")).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn count_agent_files(root: &Path) -> usize {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(root) {
        count += entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .count();
    }
    if let Ok(entries) = fs::read_dir(root.join("notes")) {
        count += entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .count();
    }
    count
}

fn agent_snapshot_status_impl(app: &tauri::AppHandle) -> Result<AgentSnapshotStatus, String> {
    let dir = agent_snapshot_root(app)?;
    let manifest_path = dir.join("manifest.json");
    let exists = manifest_path.is_file();
    let manifest = if exists {
        read_agent_manifest(&dir)
    } else {
        None
    };
    let modified_at = fs::metadata(&manifest_path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    let notes = manifest
        .as_ref()
        .and_then(|value| value.pointer("/counts/notes"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let tasks = manifest
        .as_ref()
        .and_then(|value| value.pointer("/counts/tasks"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let mcp_path = agent_mcp_binary_path();
    let mcp_exists = Path::new(&mcp_path).is_file();
    let pending_requests = count_agent_inbox_requests(&dir);

    Ok(AgentSnapshotStatus {
        dir: dir.to_string_lossy().to_string(),
        app_version: app.package_info().version.to_string(),
        exists,
        modified_at,
        file_count: count_agent_files(&dir),
        notes,
        tasks,
        pending_requests,
        mcp_path,
        mcp_exists,
    })
}

fn write_agent_file_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("非法智能体快照路径")?;
    fs::create_dir_all(parent).map_err(|error| format!("创建智能体快照目录失败：{error}"))?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let temp = parent.join(format!(".{name}.tmp-{}", std::process::id()));
    fs::write(&temp, contents).map_err(|error| format!("写入智能体快照失败：{error}"))?;
    #[cfg(windows)]
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("替换智能体快照失败：{error}")
    })
}

fn write_agent_files_into(dir: &Path, files: Vec<AgentFileInput>) -> Result<(), String> {
    if files.len() > AGENT_MAX_FILES {
        return Err("智能体快照文件数量过多".into());
    }
    let notes_dir = dir.join("notes");
    fs::create_dir_all(&notes_dir).map_err(|error| format!("创建快照目录失败：{error}"))?;

    let mut written_notes: HashSet<String> = HashSet::new();
    for file in files {
        if file.contents.len() > AGENT_MAX_FILE_BYTES {
            return Err(format!("智能体快照文件过大：{}", file.path));
        }
        let relative = allowed_agent_path(&file.path)?;
        let target = dir.join(&relative);
        write_agent_file_atomic(&target, file.contents.as_bytes())?;
        if relative.starts_with("notes") {
            if let Some(name) = relative.file_name() {
                written_notes.insert(name.to_string_lossy().to_string());
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&notes_dir) {
        for entry in entries.filter_map(Result::ok) {
            if !entry.path().is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !written_notes.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn write_agent_snapshot_impl(
    app: &tauri::AppHandle,
    files: Vec<AgentFileInput>,
) -> Result<AgentSnapshotStatus, String> {
    let dir = agent_snapshot_root(app)?;
    write_agent_files_into(&dir, files)?;
    agent_snapshot_status_impl(app)
}

#[tauri::command]
fn agent_snapshot_status(app: tauri::AppHandle) -> Result<AgentSnapshotStatus, String> {
    agent_snapshot_status_impl(&app)
}

#[tauri::command]
async fn write_agent_snapshot(
    app: tauri::AppHandle,
    files: Vec<AgentFileInput>,
) -> Result<AgentSnapshotStatus, String> {
    tauri::async_runtime::spawn_blocking(move || write_agent_snapshot_impl(&app, files))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_agent_snapshot(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = agent_snapshot_root(&app)?;
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|error| format!("清除智能体快照失败：{error}"))?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn agent_inbox_list(app: tauri::AppHandle) -> Result<Vec<AgentInboxEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = agent_snapshot_root(&app)?;
        agent_inbox_list_impl(&dir, now_ms())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn agent_inbox_resolve(
    app: tauri::AppHandle,
    file: String,
    status: String,
    entity_kind: Option<String>,
    entity_id: Option<String>,
    title: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = agent_snapshot_root(&app)?;
        agent_inbox_resolve_impl(
            &dir,
            &file,
            &status,
            entity_kind.as_deref(),
            entity_id.as_deref(),
            title.as_deref(),
            error.as_deref(),
            now_ms(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
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
    use std::time::SystemTime;

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
    fn allows_expected_agent_paths() {
        for path in [
            "manifest.json",
            "AGENTS.md",
            "notes.index.json",
            "tasks.jsonl",
            "tags.json",
            "notes/2f1c.md",
        ] {
            assert!(allowed_agent_path(path).is_ok(), "{path} should be allowed");
        }
    }

    #[test]
    fn rejects_unsafe_agent_paths() {
        for path in [
            "",
            "../secrets",
            "notes/../x.md",
            "notes/nested/a.md",
            "notes/a.json",
            "other/a.md",
            "/etc/passwd",
            "notes/中文.md",
        ] {
            assert!(
                allowed_agent_path(path).is_err(),
                "{path} should be rejected"
            );
        }
    }

    #[test]
    fn writes_and_prunes_agent_snapshot_files() {
        let root = std::env::temp_dir().join(format!(
            "lafei-agent-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/stale.md"), "old").unwrap();

        write_agent_files_into(
            &root,
            vec![
                AgentFileInput {
                    path: "manifest.json".into(),
                    contents: "{\"app\":\"lafei\"}".into(),
                },
                AgentFileInput {
                    path: "notes/fresh.md".into(),
                    contents: "---\nid: x\n---\n\nhello".into(),
                },
            ],
        )
        .unwrap();

        assert!(root.join("manifest.json").is_file());
        assert!(root.join("notes/fresh.md").is_file());
        assert!(!root.join("notes/stale.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("notes/fresh.md")).unwrap(),
            "---\nid: x\n---\n\nhello"
        );

        fs::remove_dir_all(root).unwrap();
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

    fn unique_agent_inbox_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lafei-agent-inbox-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn write_agent_inbox_request(
        dir: &Path,
        request_id: &str,
        created_at: u64,
        payload: Value,
    ) -> PathBuf {
        let inbox = dir.join("inbox");
        fs::create_dir_all(&inbox).unwrap();
        let path = inbox.join(format!("{request_id}.json"));
        let body = serde_json::json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "op": "notes.create",
            "client": "codex",
            "createdAt": created_at,
            "payload": payload,
        });
        fs::write(&path, serde_json::to_string(&body).unwrap()).unwrap();
        path
    }

    #[test]
    fn agent_inbox_accepts_valid_request_file_names() {
        for file in [
            "req-1762345678901-3f9a1c2e.json",
            "abcdefgh.json",
            "a.b_c-1234.json",
            "A1_-._b9.json",
        ] {
            let request_id = agent_inbox_request_id_from_file(file)
                .unwrap_or_else(|error| panic!("{file} 应该合法：{error}"));
            assert_eq!(format!("{request_id}.json"), file);
        }

        let longest = format!("a{}.json", "b".repeat(95));
        assert!(agent_inbox_request_id_from_file(&longest).is_ok());
        let too_long = format!("a{}.json", "b".repeat(96));
        assert!(agent_inbox_request_id_from_file(&too_long).is_err());
    }

    #[test]
    fn agent_inbox_rejects_unsafe_request_file_names() {
        for file in [
            "",
            ".hidden123.json",
            ".json",
            "short.json",
            "notes.json",
            "req/12345678.json",
            "req\\12345678.json",
            "../req12345678.json",
            "..",
            "req..12345678.json",
            "req 12345678.json",
            "req12345678.JSON",
            "req12345678",
            "req12345678.txt",
            "中文请求12345678.json",
        ] {
            assert!(
                agent_inbox_request_id_from_file(file).is_err(),
                "{file:?} 应该被拒绝"
            );
        }
    }

    #[test]
    fn agent_inbox_list_sorts_and_skips_bad_files() {
        let root = unique_agent_inbox_dir("list");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("inbox")).unwrap();
        write_agent_inbox_request(
            &root,
            "req-1762345670000-aaaaaaaa",
            300,
            serde_json::json!({ "title": "later" }),
        );
        write_agent_inbox_request(
            &root,
            "req-1762345670001-bbbbbbbb",
            100,
            serde_json::json!({ "title": "first" }),
        );
        write_agent_inbox_request(
            &root,
            "req-1762345670002-cccccccc",
            200,
            serde_json::json!({ "title": "middle" }),
        );
        fs::write(root.join("inbox/bad-json-0001.json"), "{not json").unwrap();
        fs::write(root.join("inbox/short.json"), "{}").unwrap();
        fs::create_dir_all(root.join("inbox/nested")).unwrap();

        let entries = agent_inbox_list_impl(&root, now_ms()).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].request_id, "req-1762345670001-bbbbbbbb");
        assert_eq!(entries[1].request_id, "req-1762345670002-cccccccc");
        assert_eq!(entries[2].request_id, "req-1762345670000-aaaaaaaa");
        assert_eq!(entries[0].file, "req-1762345670001-bbbbbbbb.json");
        assert_eq!(entries[0].op, "notes.create");
        assert_eq!(entries[0].client.as_deref(), Some("codex"));
        assert_eq!(entries[0].created_at, 100);
        assert_eq!(entries[0].payload["title"], "first");
        assert!(root.join("inbox/bad-json-0001.json").is_file());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agent_inbox_list_caps_at_100_entries() {
        let root = unique_agent_inbox_dir("cap");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("inbox")).unwrap();
        for index in 0..105u64 {
            let request_id = format!("req-1762345678{index:03}-{index:08x}");
            write_agent_inbox_request(&root, &request_id, index, Value::Null);
        }

        let entries = agent_inbox_list_impl(&root, now_ms()).unwrap();
        assert_eq!(entries.len(), 100);
        assert_eq!(entries[0].created_at, 0);
        assert_eq!(entries[99].created_at, 99);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agent_inbox_list_missing_dir_is_empty() {
        let root = unique_agent_inbox_dir("missing");
        let _ = fs::remove_dir_all(&root);
        assert!(agent_inbox_list_impl(&root, now_ms()).unwrap().is_empty());
        assert_eq!(count_agent_inbox_requests(&root), 0);
    }

    #[test]
    fn agent_inbox_cleanup_removes_expired_files() {
        let root = unique_agent_inbox_dir("cleanup");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("inbox/done")).unwrap();
        fs::create_dir_all(root.join("inbox/failed")).unwrap();
        write_agent_inbox_request(
            &root,
            "req-1762345670000-aaaaaaaa",
            1,
            serde_json::json!({}),
        );
        write_agent_inbox_request(
            &root,
            "req-1762345670001-bbbbbbbb",
            2,
            serde_json::json!({}),
        );
        fs::write(
            root.join("inbox/done/req-1762345670002-cccccccc.json"),
            "{}",
        )
        .unwrap();
        fs::write(
            root.join("inbox/failed/req-1762345670003-dddddddd.json"),
            "{}",
        )
        .unwrap();

        let now = now_ms();
        let ten_days = 10 * 24 * 60 * 60 * 1000;
        assert_eq!(
            agent_inbox_list_impl(&root, now + ten_days).unwrap().len(),
            2
        );
        // inbox 里 30 天内的请求保留；done/failed 里超过 7 天的结果被清理。
        assert!(root.join("inbox/req-1762345670000-aaaaaaaa.json").is_file());
        assert!(!root
            .join("inbox/done/req-1762345670002-cccccccc.json")
            .exists());
        assert!(!root
            .join("inbox/failed/req-1762345670003-dddddddd.json")
            .exists());

        let month = 31 * 24 * 60 * 60 * 1000;
        assert!(agent_inbox_list_impl(&root, now + month)
            .unwrap()
            .is_empty());
        assert!(!root.join("inbox/req-1762345670000-aaaaaaaa.json").exists());
        assert!(!root.join("inbox/req-1762345670001-bbbbbbbb.json").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agent_inbox_resolve_moves_and_merges_result() {
        let root = unique_agent_inbox_dir("resolve");
        let _ = fs::remove_dir_all(&root);
        write_agent_inbox_request(
            &root,
            "req-1762345670000-aaaaaaaa",
            42,
            serde_json::json!({ "title": "外部笔记", "content": "正文" }),
        );
        let file = "req-1762345670000-aaaaaaaa.json";

        agent_inbox_resolve_impl(
            &root,
            file,
            "applied",
            Some("note"),
            Some("note-1"),
            Some("外部笔记"),
            None,
            999,
        )
        .unwrap();

        assert!(!root.join("inbox").join(file).exists());
        let done = root.join("inbox/done").join(file);
        assert!(done.is_file());
        let value: Value = serde_json::from_str(&fs::read_to_string(&done).unwrap()).unwrap();
        assert_eq!(value["requestId"], "req-1762345670000-aaaaaaaa");
        assert_eq!(value["op"], "notes.create");
        assert_eq!(value["client"], "codex");
        assert_eq!(value["createdAt"], 42);
        assert_eq!(value["payload"]["title"], "外部笔记");
        assert_eq!(value["result"]["status"], "applied");
        assert_eq!(value["result"]["appliedAt"], 999);
        assert_eq!(value["result"]["entityKind"], "note");
        assert_eq!(value["result"]["entityId"], "note-1");
        assert_eq!(value["result"]["title"], "外部笔记");

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agent_inbox_resolve_writes_failed_result() {
        let root = unique_agent_inbox_dir("failed");
        let _ = fs::remove_dir_all(&root);
        write_agent_inbox_request(
            &root,
            "req-1762345670000-aaaaaaaa",
            5,
            serde_json::json!({ "title": "" }),
        );
        let file = "req-1762345670000-aaaaaaaa.json";

        agent_inbox_resolve_impl(
            &root,
            file,
            "rejected",
            None,
            None,
            None,
            Some("任务标题不能为空"),
            7,
        )
        .unwrap();

        let failed = root.join("inbox/failed").join(file);
        assert!(failed.is_file());
        let value: Value = serde_json::from_str(&fs::read_to_string(&failed).unwrap()).unwrap();
        assert_eq!(value["result"]["status"], "rejected");
        assert_eq!(value["result"]["appliedAt"], 7);
        assert_eq!(value["result"]["error"], "任务标题不能为空");
        assert!(value["result"].get("entityKind").is_none());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agent_inbox_resolve_is_idempotent() {
        let root = unique_agent_inbox_dir("idempotent");
        let _ = fs::remove_dir_all(&root);
        write_agent_inbox_request(
            &root,
            "req-1762345670000-aaaaaaaa",
            1,
            serde_json::json!({ "title": "任务", "priority": "high" }),
        );
        let file = "req-1762345670000-aaaaaaaa.json";

        agent_inbox_resolve_impl(
            &root,
            file,
            "applied",
            Some("task"),
            Some("task-1"),
            Some("任务"),
            None,
            100,
        )
        .unwrap();
        let done = root.join("inbox/done").join(file);
        let first = fs::read_to_string(&done).unwrap();

        agent_inbox_resolve_impl(
            &root,
            file,
            "applied",
            Some("task"),
            Some("task-1"),
            Some("任务"),
            None,
            200,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&done).unwrap(), first);

        // 已结算后原始请求又被放回 inbox：重复结算只清理原文件，不会改写已完成的结果。
        fs::write(
            root.join("inbox").join(file),
            r#"{"op":"notes.create","createdAt":1,"payload":{}}"#,
        )
        .unwrap();
        agent_inbox_resolve_impl(&root, file, "rejected", None, None, None, Some("失败"), 300)
            .unwrap();
        assert!(!root.join("inbox").join(file).exists());
        assert!(!root.join("inbox/failed").join(file).exists());
        assert_eq!(fs::read_to_string(&done).unwrap(), first);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agent_inbox_resolve_rejects_bad_inputs() {
        let root = unique_agent_inbox_dir("reject");
        let _ = fs::remove_dir_all(&root);
        write_agent_inbox_request(
            &root,
            "req-1762345670000-aaaaaaaa",
            1,
            serde_json::json!({}),
        );
        let file = "req-1762345670000-aaaaaaaa.json";

        for bad_file in [
            "../req-1762345670000-aaaaaaaa.json",
            "/tmp/req-1762345670000-aaaaaaaa.json",
            "req..12345678.json",
            ".hidden123.json",
            "req12345678.txt",
        ] {
            assert!(
                agent_inbox_resolve_impl(&root, bad_file, "applied", None, None, None, None, 1)
                    .is_err(),
                "{bad_file:?} 应该被拒绝"
            );
        }
        assert!(agent_inbox_resolve_impl(&root, file, "done", None, None, None, None, 1).is_err());
        assert!(agent_inbox_resolve_impl(
            &root,
            file,
            "applied",
            Some("chat"),
            None,
            None,
            None,
            1
        )
        .is_err());
        assert!(agent_inbox_resolve_impl(
            &root,
            "req-1762345670009-zzzzzzzz.json",
            "applied",
            None,
            None,
            None,
            None,
            1
        )
        .is_err());
        // 非法参数不应动到原请求文件。
        assert!(root.join("inbox").join(file).is_file());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn agent_inbox_pending_requests_count() {
        let root = unique_agent_inbox_dir("pending");
        let _ = fs::remove_dir_all(&root);
        write_agent_inbox_request(
            &root,
            "req-1762345670000-aaaaaaaa",
            1,
            serde_json::json!({}),
        );
        write_agent_inbox_request(
            &root,
            "req-1762345670001-bbbbbbbb",
            2,
            serde_json::json!({}),
        );
        fs::write(root.join("inbox/bad-json-0001.json"), "oops").unwrap();
        fs::write(root.join("inbox/short.json"), "{}").unwrap();
        assert_eq!(count_agent_inbox_requests(&root), 2);

        agent_inbox_resolve_impl(
            &root,
            "req-1762345670000-aaaaaaaa.json",
            "applied",
            Some("note"),
            Some("note-1"),
            Some("标题"),
            None,
            1,
        )
        .unwrap();
        assert_eq!(count_agent_inbox_requests(&root), 1);

        fs::remove_dir_all(&root).unwrap();
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
            agent_snapshot_status,
            write_agent_snapshot,
            clear_agent_snapshot,
            agent_inbox_list,
            agent_inbox_resolve,
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
