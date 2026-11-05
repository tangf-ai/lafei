use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FALLBACK_PROTOCOL: &str = "2025-06-18";
const SERVER_NAME: &str = "lafei-mcp";

// 写入队列契约（见 agent 快照 manifest 的 writer 字段）
const WRITE_SCHEMA_VERSION: u64 = 1;
const DEFAULT_MAX_PENDING: usize = 200;
const MAX_TITLE_CHARS: usize = 200;
const MAX_NOTE_CONTENT_CHARS: usize = 262_144;
const MAX_TASK_DESCRIPTION_CHARS: usize = 65_536;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 64;
const WRITE_POLL_TIMEOUT: Duration = Duration::from_millis(2000);
const REUSE_POLL_TIMEOUT: Duration = Duration::from_millis(800);
const POLL_INTERVAL: Duration = Duration::from_millis(40);
const QUEUED_MESSAGE: &str =
    "Lafei 应用当前未运行或尚未处理请求；请求已排队，Lafei 启动后会自动创建。";
const WRITE_DISABLED_MESSAGE: &str = "Lafei 未开启智能体写入：请在 Lafei 设置 → 智能体访问中开启「允许外部智能体新建笔记和任务」并重新导出快照后重试";

#[derive(Debug)]
struct Options {
    data_dir: PathBuf,
}

fn default_data_dir() -> PathBuf {
    if let Ok(value) = env::var("LAFEI_AGENT_DIR") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }
    let home = env::var("HOME").unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        return Path::new(&home).join("Library/Application Support/app.lafei.desktop/agent");
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = env::var("APPDATA").unwrap_or_else(|_| home.clone());
        return Path::new(&appdata).join("app.lafei.desktop").join("agent");
    }
    #[cfg(target_os = "linux")]
    {
        let data_home = env::var("XDG_DATA_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| format!("{home}/.local/share"));
        return Path::new(&data_home)
            .join("app.lafei.desktop")
            .join("agent");
    }
    #[allow(unreachable_code)]
    Path::new(&home).join(".lafei/agent")
}

fn usage() {
    println!(
        "lafei-mcp {}\n\nMCP server for Lafei notes and tasks. Read-only by default; after the user enables agent writes in Lafei, notes_create / tasks_create queue new items through the local agent inbox.\n\nUsage:\n  lafei-mcp [--data-dir <path>]\n\nOptions:\n  --data-dir <path>   Lafei agent snapshot directory (default: platform app data dir)\n  -h, --help          Show this help\n  -V, --version       Show version\n\nEnvironment:\n  LAFEI_AGENT_DIR     Override the snapshot directory\n",
        env!("CARGO_PKG_VERSION")
    );
}

fn parse_options() -> Option<Options> {
    let mut data_dir = default_data_dir();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                usage();
                return None;
            }
            "-V" | "--version" => {
                println!("lafei-mcp {}", env!("CARGO_PKG_VERSION"));
                return None;
            }
            "--data-dir" => {
                let value = args.next().unwrap_or_default();
                if value.trim().is_empty() {
                    eprintln!("--data-dir 需要一个路径");
                    std::process::exit(2);
                }
                data_dir = PathBuf::from(value);
            }
            other if other.starts_with("--data-dir=") => {
                let value = other.trim_start_matches("--data-dir=");
                if value.trim().is_empty() {
                    eprintln!("--data-dir 需要一个路径");
                    std::process::exit(2);
                }
                data_dir = PathBuf::from(value);
            }
            other => {
                eprintln!("未知参数：{other}（使用 --help 查看用法）");
                std::process::exit(2);
            }
        }
    }
    Some(Options { data_dir })
}

struct Store {
    dir: PathBuf,
}

impl Store {
    fn read(&self, relative: &str) -> Option<String> {
        let path = Path::new(relative);
        if path.is_absolute() {
            return None;
        }
        if !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return None;
        }
        fs::read_to_string(self.dir.join(path)).ok()
    }

    fn notes_index(&self) -> Vec<Value> {
        self.read("notes.index.json")
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    }

    fn tasks(&self) -> Vec<Value> {
        self.read("tasks.jsonl")
            .map(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn tags(&self) -> Value {
        self.read("tags.json")
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .unwrap_or_else(|| json!([]))
    }

    fn note(&self, id: &str) -> Option<(Value, String)> {
        let item = self
            .notes_index()
            .into_iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(id))?;
        let file = item.get("file").and_then(Value::as_str)?;
        let markdown = self.read(file)?;
        Some((item, markdown))
    }
}

/// 单次 MCP 会话：保存快照目录和 initialize 上报的客户端名称（写入队列时作为 client 字段）。
struct Session {
    store: Store,
    client: Option<String>,
}

fn initialize_client_name(params: &Value) -> Option<String> {
    params
        .get("clientInfo")
        .and_then(|info| info.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 写入请求的轮询策略；单测会传入更短的超时。
#[derive(Debug, Clone, Copy)]
struct PollPolicy {
    timeout: Duration,
    interval: Duration,
}

impl PollPolicy {
    const DEFAULT: Self = Self {
        timeout: WRITE_POLL_TIMEOUT,
        interval: POLL_INTERVAL,
    };

    /// 复用已有 requestId 时只做短轮询。
    fn reuse(&self) -> Self {
        Self {
            timeout: self.timeout.min(REUSE_POLL_TIMEOUT),
            interval: self.interval,
        }
    }
}

/// manifest.json 中 writer 字段解析后的写入配置。
#[derive(Debug, Clone)]
struct Writer {
    inbox: PathBuf,
    done: PathBuf,
    failed: PathBuf,
    max_pending: usize,
}

impl Writer {
    /// 仅当 manifest.json 存在、可解析且 writer.enabled === true 时视为可写。
    fn load(store: &Store) -> Option<Self> {
        let manifest: Value = store
            .read("manifest.json")
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
        let writer = manifest.get("writer")?;
        if writer.get("enabled").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let max_pending = writer
            .get("maxPending")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_MAX_PENDING);
        Some(Self {
            inbox: store.dir.join(relative_path(writer.get("inbox"), "inbox")),
            done: store
                .dir
                .join(relative_path(writer.get("processed"), "inbox/done")),
            failed: store
                .dir
                .join(relative_path(writer.get("failed"), "inbox/failed")),
            max_pending,
        })
    }
}

/// manifest 里的路径只接受普通相对路径段，非法时退回默认值。
fn relative_path(value: Option<&Value>, fallback: &str) -> PathBuf {
    let Some(candidate) = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return PathBuf::from(fallback);
    };
    let path = Path::new(candidate);
    if path.is_absolute()
        || !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
    {
        return PathBuf::from(fallback);
    }
    path.to_path_buf()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// requestId 规则：8–96 个 [A-Za-z0-9._-]，首字符为字母或数字，且不含 `..`。
fn valid_request_id(value: &str) -> bool {
    let count = value.chars().count();
    if !(8..=96).contains(&count) || value.contains("..") {
        return false;
    }
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'))
}

fn valid_request_file_name(name: &str) -> bool {
    name.strip_suffix(".json")
        .map(valid_request_id)
        .unwrap_or(false)
}

/// 随机片段：时间纳秒 + 进程号 + 进程内计数器混合，避免引入 rand 依赖。
fn next_random_u32() -> u32 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let mut mixed = nanos ^ (pid << 32) ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    mixed ^= mixed >> 31;
    (mixed & 0xFFFF_FFFF) as u32
}

fn generate_request_id() -> String {
    format!("req-{}-{:08x}", now_millis(), next_random_u32())
}

fn next_temp_counter() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// 先写同目录 .tmp-<pid>-<n>，再 rename 到目标文件名；Windows 下目标已存在时先删除。
fn atomic_write(dir: &Path, file_name: &str, contents: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|error| format!("创建队列目录失败：{error}"))?;
    let tmp_path = dir.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        next_temp_counter()
    ));
    let target = dir.join(file_name);
    let write_result = (|| -> io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        drop(file);
        #[cfg(target_os = "windows")]
        {
            if target.exists() {
                fs::remove_file(&target)?;
            }
        }
        fs::rename(&tmp_path, &target)
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("写入队列文件失败：{error}"));
    }
    Ok(())
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// inbox 里可解析的有效待处理请求数，口径与桌面端 pendingRequests 保持一致。
fn pending_count(writer: &Writer) -> usize {
    let Ok(entries) = fs::read_dir(&writer.inbox) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter(|entry| valid_request_file_name(&entry.file_name().to_string_lossy()))
        .filter(|entry| {
            read_json_file(&entry.path())
                .map(|request| valid_queue_request(&request))
                .unwrap_or(false)
        })
        .count()
}

fn valid_queue_request(request: &Value) -> bool {
    let Some(object) = request.as_object() else {
        return false;
    };
    let op_ok = object
        .get("op")
        .and_then(Value::as_str)
        .map(|op| !op.trim().is_empty())
        .unwrap_or(false);
    let created_ok = object.get("createdAt").and_then(Value::as_u64).is_some();
    op_ok && created_ok
}

enum Settlement {
    Done(Value),
    Failed(Value),
}

fn poll_settlement(writer: &Writer, request_id: &str, policy: PollPolicy) -> Option<Settlement> {
    let deadline = Instant::now() + policy.timeout;
    let file_name = format!("{request_id}.json");
    loop {
        if let Some(request) = read_json_file(&writer.done.join(&file_name)) {
            return Some(Settlement::Done(request));
        }
        if let Some(request) = read_json_file(&writer.failed.join(&file_name)) {
            return Some(Settlement::Failed(request));
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(policy.interval);
    }
}

fn created_response(request_id: &str, default_kind: &str, request: &Value) -> Value {
    let result = request.get("result").cloned().unwrap_or(Value::Null);
    let kind = result
        .get("entityKind")
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "note" | "task"))
        .unwrap_or(default_kind);
    let id = result.get("entityId").cloned().unwrap_or_else(|| json!(""));
    let title = result
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| {
            request
                .get("payload")
                .and_then(|payload| payload.get("title"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    json!({
        "status": "created",
        "requestId": request_id,
        "kind": kind,
        "id": id,
        "title": title
    })
}

fn rejected_message(label: &str, request_id: &str, request: &Value) -> String {
    let error = request
        .get("result")
        .and_then(|result| result.get("error"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("应用未返回失败原因");
    format!("Lafei 应用拒绝创建{label}（{request_id}）：{error}")
}

fn queued_response(request_id: &str) -> Value {
    json!({
        "status": "queued",
        "requestId": request_id,
        "message": QUEUED_MESSAGE
    })
}

/// 写入操作标识：队列里的 op、返回给客户端的 kind、错误文案里的中文名词。
#[derive(Debug, Clone, Copy)]
struct WriteOp {
    op: &'static str,
    kind: &'static str,
    label: &'static str,
}

impl WriteOp {
    const NOTES: Self = Self {
        op: "notes.create",
        kind: "note",
        label: "笔记",
    };
    const TASKS: Self = Self {
        op: "tasks.create",
        kind: "task",
        label: "任务",
    };
}

/// 校验参数 → 判可写 → 幂等检查 → 原子写队列 → 轮询结果。
fn submit_write(
    store: &Store,
    client: Option<&str>,
    write_op: WriteOp,
    payload: Value,
    requested_id: Option<String>,
    policy: PollPolicy,
) -> Result<Value, String> {
    let writer = Writer::load(store).ok_or_else(|| WRITE_DISABLED_MESSAGE.to_string())?;
    let pending = pending_count(&writer);
    if pending >= writer.max_pending {
        return Err(format!(
            "Lafei 写入队列已满（待处理 {pending} 条，上限 {}），请等待 Lafei 处理后再试",
            writer.max_pending
        ));
    }
    let request_id = match requested_id {
        Some(id) => {
            let file_name = format!("{id}.json");
            if let Some(request) = read_json_file(&writer.done.join(&file_name)) {
                return Ok(created_response(&id, write_op.kind, &request));
            }
            if let Some(request) = read_json_file(&writer.failed.join(&file_name)) {
                return Err(rejected_message(write_op.label, &id, &request));
            }
            if writer.inbox.join(&file_name).exists() {
                // 同一个 requestId 已经在队列里：短轮询等待应用处理，避免重复写入
                return match poll_settlement(&writer, &id, policy.reuse()) {
                    Some(Settlement::Done(request)) => {
                        Ok(created_response(&id, write_op.kind, &request))
                    }
                    Some(Settlement::Failed(request)) => {
                        Err(rejected_message(write_op.label, &id, &request))
                    }
                    None => Ok(queued_response(&id)),
                };
            }
            id
        }
        None => generate_request_id(),
    };
    let request = json!({
        "schemaVersion": WRITE_SCHEMA_VERSION,
        "requestId": request_id,
        "op": write_op.op,
        "client": client,
        "createdAt": now_millis(),
        "payload": payload
    });
    let text = serde_json::to_string_pretty(&request)
        .map_err(|error| format!("序列化写入请求失败：{error}"))?;
    atomic_write(&writer.inbox, &format!("{request_id}.json"), &text)?;
    match poll_settlement(&writer, &request_id, policy) {
        Some(Settlement::Done(request)) => {
            Ok(created_response(&request_id, write_op.kind, &request))
        }
        Some(Settlement::Failed(request)) => {
            Err(rejected_message(write_op.label, &request_id, &request))
        }
        None => Ok(queued_response(&request_id)),
    }
}

fn required_title(args: &Value, label: &str) -> Result<String, String> {
    let value = match args.get("title") {
        Some(Value::String(value)) => value.as_str(),
        Some(_) => return Err(format!("{label}标题必须是字符串")),
        None => return Err(format!("{label}标题不能为空")),
    };
    let title = value.trim();
    let count = title.chars().count();
    if count == 0 {
        return Err(format!("{label}标题不能为空"));
    }
    if count > MAX_TITLE_CHARS {
        return Err(format!("{label}标题最多 {MAX_TITLE_CHARS} 个字符"));
    }
    Ok(title.to_string())
}

fn optional_string(args: &Value, key: &str, default: &str) -> Result<String, String> {
    match args.get(key) {
        None => Ok(default.to_string()),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(format!("{key} 必须是字符串")),
    }
}

fn normalize_tags(value: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err("tags 必须是字符串数组".into());
    };
    if items.len() > MAX_TAGS {
        return Err(format!("标签最多 {MAX_TAGS} 个"));
    }
    let mut seen = HashSet::new();
    let mut tags = Vec::new();
    for item in items {
        let Some(raw) = item.as_str() else {
            return Err("tags 的每一项都必须是字符串".into());
        };
        // 依次 trim、去掉开头 #、再 trim；长度按字符数计算
        let tag = raw.trim().trim_start_matches('#').trim();
        let count = tag.chars().count();
        if count == 0 {
            return Err("标签不能为空（去掉 # 后至少 1 个字符）".into());
        }
        if count > MAX_TAG_CHARS {
            return Err(format!("单个标签最多 {MAX_TAG_CHARS} 个字符：{tag}"));
        }
        if seen.insert(tag.to_string()) {
            tags.push(tag.to_string());
        }
    }
    Ok(tags)
}

fn is_leap_year(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// 校验 YYYY-MM-DD 且为真实存在的日期。
fn valid_due_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if index == 4 || index == 7 {
            continue;
        }
        if !byte.is_ascii_digit() {
            return false;
        }
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    if year == 0 || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap_year(year) => 29,
        _ => 28,
    };
    day <= max_day
}

fn validate_note_payload(args: &Value) -> Result<Value, String> {
    let title = required_title(args, "笔记")?;
    let content = optional_string(args, "content", "")?;
    if content.chars().count() > MAX_NOTE_CONTENT_CHARS {
        return Err(format!("笔记内容最多 {MAX_NOTE_CONTENT_CHARS} 个字符"));
    }
    let tags = normalize_tags(args.get("tags"))?;
    let pinned = match args.get("pinned") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("pinned 必须是布尔值".into()),
    };
    Ok(json!({
        "title": title,
        "content": content,
        "tags": tags,
        "pinned": pinned
    }))
}

fn validate_task_payload(store: &Store, args: &Value) -> Result<Value, String> {
    let title = required_title(args, "任务")?;
    let description = optional_string(args, "description", "")?;
    if description.chars().count() > MAX_TASK_DESCRIPTION_CHARS {
        return Err(format!("任务描述最多 {MAX_TASK_DESCRIPTION_CHARS} 个字符"));
    }
    let due_date = match args.get("dueDate") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if !valid_due_date(trimmed) {
                return Err("dueDate 必须是 YYYY-MM-DD 格式的真实日期".into());
            }
            json!(trimmed)
        }
        Some(_) => return Err("dueDate 必须是字符串或 null".into()),
    };
    let priority = match args.get("priority") {
        None => "medium".to_string(),
        Some(Value::String(value)) if matches!(value.as_str(), "high" | "medium" | "low") => {
            value.clone()
        }
        Some(_) => return Err("priority 只能是 high、medium、low".into()),
    };
    let tags = normalize_tags(args.get("tags"))?;
    let note_id = match args.get("noteId") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(value)) => {
            let id = value.trim();
            if id.is_empty() {
                return Err("noteId 不能为空字符串".into());
            }
            let exists = store
                .notes_index()
                .iter()
                .any(|item| item.get("id").and_then(Value::as_str) == Some(id));
            if !exists {
                return Err(format!("noteId 对应的笔记不存在：{id}"));
            }
            json!(id)
        }
        Some(_) => return Err("noteId 必须是字符串或 null".into()),
    };
    Ok(json!({
        "title": title,
        "description": description,
        "dueDate": due_date,
        "priority": priority,
        "tags": tags,
        "noteId": note_id
    }))
}

fn requested_request_id(args: &Value) -> Result<Option<String>, String> {
    match args.get("requestId") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let id = value.trim();
            if !valid_request_id(id) {
                return Err("requestId 不合法：需为 8–96 个字母、数字、点、下划线或连字符，以字母或数字开头且不含 ..".into());
            }
            Ok(Some(id.to_string()))
        }
        Some(_) => Err("requestId 必须是字符串".into()),
    }
}

fn notes_create(session: &Session, args: &Value) -> Result<Value, String> {
    let payload = validate_note_payload(args)?;
    let requested_id = requested_request_id(args)?;
    submit_write(
        &session.store,
        session.client.as_deref(),
        WriteOp::NOTES,
        payload,
        requested_id,
        PollPolicy::DEFAULT,
    )
}

fn tasks_create(session: &Session, args: &Value) -> Result<Value, String> {
    let payload = validate_task_payload(&session.store, args)?;
    let requested_id = requested_request_id(args)?;
    submit_write(
        &session.store,
        session.client.as_deref(),
        WriteOp::TASKS,
        payload,
        requested_id,
        PollPolicy::DEFAULT,
    )
}

fn initialize_result(params: &Value) -> Value {
    let requested = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(FALLBACK_PROTOCOL);
    json!({
        "protocolVersion": requested,
        "capabilities": {
            "tools": { "listChanged": false },
            "resources": { "subscribe": false, "listChanged": false }
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION")
        },
        "instructions": "Lafei is a local-first notes and tasks app. This server is read-only by default: use notes_search / notes_get / tasks_list / tasks_get / tags_list, and cite note ids or titles when answering. After the user turns on agent writes in Lafei, notes_create and tasks_create become available: they queue a request in the local Lafei agent inbox and return status created or queued."
    })
}

fn tool_definitions() -> Value {
    let read_only = json!({ "readOnlyHint": true, "openWorldHint": false, "idempotentHint": true });
    let write_annotations = json!({
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": false
    });
    json!([
        {
            "name": "notes_search",
            "title": "Search Lafei notes",
            "description": "Search the user's Lafei notes by title, tags and content. Returns compact results with note ids that can be passed to notes_get.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Keywords to search for" },
                    "tag": { "type": "string", "description": "Optional tag filter (without #)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 }
                },
                "required": ["query"],
                "additionalProperties": false
            },
            "annotations": read_only
        },
        {
            "name": "notes_get",
            "title": "Read a Lafei note",
            "description": "Read one note's full Markdown content and metadata by id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Note id from notes_search" } },
                "required": ["id"],
                "additionalProperties": false
            },
            "annotations": read_only
        },
        {
            "name": "tasks_list",
            "title": "List Lafei tasks",
            "description": "List tasks with optional status, tag and due-date filters. Returns tasks sorted by due date, priority and update time.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["open", "done", "all"], "default": "open" },
                    "tag": { "type": "string", "description": "Optional tag filter (without #)" },
                    "dueFrom": { "type": "string", "description": "Include tasks due on/after this ISO date (YYYY-MM-DD)" },
                    "dueTo": { "type": "string", "description": "Include tasks due on/before this ISO date (YYYY-MM-DD)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 50, "default": 20 }
                },
                "additionalProperties": false
            },
            "annotations": read_only
        },
        {
            "name": "tasks_get",
            "title": "Read a Lafei task",
            "description": "Read one task by id.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string", "description": "Task id" } },
                "required": ["id"],
                "additionalProperties": false
            },
            "annotations": read_only
        },
        {
            "name": "tags_list",
            "title": "List Lafei tags",
            "description": "List all tags with their note and task counts.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            },
            "annotations": read_only
        },
        {
            "name": "notes_create",
            "title": "Create a Lafei note",
            "description": "Create a Lafei note. Requires agent writes to be enabled in Lafei: the request is queued in the local agent inbox, and the tool waits briefly for the app to apply it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "content": { "type": "string", "maxLength": 262144 },
                    "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
                    "pinned": { "type": "boolean", "default": false },
                    "requestId": { "type": "string", "description": "Optional idempotency key; reuse on retry" }
                },
                "required": ["title"],
                "additionalProperties": false
            },
            "annotations": write_annotations
        },
        {
            "name": "tasks_create",
            "title": "Create a Lafei task",
            "description": "Create a Lafei task. Requires agent writes to be enabled in Lafei: the request is queued in the local agent inbox, and the tool waits briefly for the app to apply it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "description": { "type": "string", "maxLength": 65536 },
                    "dueDate": { "type": ["string", "null"], "description": "Due date as YYYY-MM-DD, or null for no date" },
                    "priority": { "type": "string", "enum": ["high", "medium", "low"], "default": "medium" },
                    "tags": { "type": "array", "items": { "type": "string" }, "maxItems": 20 },
                    "noteId": { "type": ["string", "null"], "description": "Existing note id from notes_search, or null" },
                    "requestId": { "type": "string", "description": "Optional idempotency key; reuse on retry" }
                },
                "required": ["title"],
                "additionalProperties": false
            },
            "annotations": write_annotations
        }
    ])
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn arg_limit(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default)
        .clamp(1, max)
}

fn tag_matches(item: &Value, tag: &str) -> bool {
    item.get("tags")
        .and_then(Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(Value::as_str)
                .any(|value| value.to_lowercase() == tag.to_lowercase())
        })
        .unwrap_or(false)
}

fn note_body(markdown: &str) -> &str {
    if let Some(rest) = markdown.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            return &rest[end + 5..];
        }
    }
    markdown
}

fn snippet(text: &str, terms: &[String]) -> String {
    let lower = text.to_lowercase();
    for term in terms {
        if let Some(position) = lower.find(term) {
            let mut start = position.saturating_sub(50);
            while start > 0 && !text.is_char_boundary(start) {
                start -= 1;
            }
            let mut end = (position + term.len() + 110).min(text.len());
            while end < text.len() && !text.is_char_boundary(end) {
                end += 1;
            }
            let prefix = if start > 0 { "…" } else { "" };
            let suffix = if end < text.len() { "…" } else { "" };
            return format!("{prefix}{}{suffix}", text[start..end].replace('\n', " "));
        }
    }
    let mut end = 160.min(text.len());
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    format!(
        "{}{}",
        text[..end].replace('\n', " "),
        if end < text.len() { "…" } else { "" }
    )
}

fn notes_search(store: &Store, args: &Value) -> Result<Value, String> {
    let query = arg_str(args, "query").unwrap_or("").trim();
    if query.is_empty() {
        return Err("query 不能为空".into());
    }
    let tag = arg_str(args, "tag")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = arg_limit(args, "limit", 8, 20);
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| term.to_lowercase())
        .collect();
    let mut hits: Vec<(i64, Value)> = Vec::new();

    for item in store.notes_index() {
        if let Some(tag) = tag {
            if !tag_matches(&item, tag) {
                continue;
            }
        }
        let id = item.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let tags = item
            .get("tags")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
                    .to_lowercase()
            })
            .unwrap_or_default();
        let excerpt = item
            .get("excerpt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let mut score = 0i64;
        for term in &terms {
            if title.contains(term) {
                score += 60;
            }
            if tags.contains(term) {
                score += 30;
            }
            if excerpt.contains(term) {
                score += 10;
            }
        }

        let markdown = item
            .get("file")
            .and_then(Value::as_str)
            .and_then(|file| store.read(file))
            .unwrap_or_default();
        let lower_markdown = markdown.to_lowercase();
        for term in &terms {
            let count = lower_markdown.matches(term).count();
            if count > 0 {
                score += 5 + (count.min(6) as i64 * 4);
            }
        }
        if score == 0 {
            continue;
        }

        let body = if markdown.is_empty() {
            excerpt.clone()
        } else {
            note_body(&markdown).to_string()
        };
        hits.push((
            score,
            json!({
                "id": id,
                "title": item.get("title").cloned().unwrap_or(json!("")),
                "tags": item.get("tags").cloned().unwrap_or(json!([])),
                "pinned": item.get("pinned").cloned().unwrap_or(json!(false)),
                "updatedAt": item.get("updatedAt").cloned().unwrap_or(json!(0)),
                "snippet": snippet(&body, &terms)
            }),
        ));
    }

    hits.sort_by(|a, b| b.0.cmp(&a.0));
    let results: Vec<Value> = hits
        .into_iter()
        .take(limit)
        .map(|(_, value)| value)
        .collect();
    Ok(json!({
        "query": query,
        "tag": tag,
        "count": results.len(),
        "results": results
    }))
}

fn notes_get(store: &Store, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "id").unwrap_or("").trim();
    if id.is_empty() {
        return Err("id 不能为空".into());
    }
    let (item, markdown) = store.note(id).ok_or_else(|| format!("找不到笔记：{id}"))?;
    Ok(json!({
        "id": item.get("id").cloned().unwrap_or(json!(id)),
        "title": item.get("title").cloned().unwrap_or(json!("")),
        "tags": item.get("tags").cloned().unwrap_or(json!([])),
        "pinned": item.get("pinned").cloned().unwrap_or(json!(false)),
        "createdAt": item.get("createdAt").cloned().unwrap_or(json!(0)),
        "updatedAt": item.get("updatedAt").cloned().unwrap_or(json!(0)),
        "markdown": markdown,
        "content": note_body(&markdown)
    }))
}

fn task_weight(task: &Value) -> i64 {
    match task.get("priority").and_then(Value::as_str) {
        Some("high") => 3,
        Some("low") => 1,
        _ => 2,
    }
}

fn due_key(task: &Value) -> String {
    task.get("dueDate")
        .and_then(Value::as_str)
        .unwrap_or("9999-12-31")
        .to_string()
}

fn tasks_list(store: &Store, args: &Value) -> Result<Value, String> {
    let status = arg_str(args, "status").unwrap_or("open");
    let tag = arg_str(args, "tag")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let due_from = arg_str(args, "dueFrom")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let due_to = arg_str(args, "dueTo")
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let limit = arg_limit(args, "limit", 20, 50);

    let mut tasks: Vec<Value> = store
        .tasks()
        .into_iter()
        .filter(|task| {
            let done = task.get("done").and_then(Value::as_bool).unwrap_or(false);
            match status {
                "open" if done => return false,
                "done" if !done => return false,
                _ => {}
            }
            if let Some(tag) = tag {
                if !tag_matches(task, tag) {
                    return false;
                }
            }
            let due = task.get("dueDate").and_then(Value::as_str);
            if let Some(from) = due_from {
                if due.map(|value| value < from).unwrap_or(true) {
                    return false;
                }
            }
            if let Some(to) = due_to {
                if due.map(|value| value > to).unwrap_or(true) {
                    return false;
                }
            }
            true
        })
        .collect();

    tasks.sort_by(|a, b| {
        let a_done = a.get("done").and_then(Value::as_bool).unwrap_or(false);
        let b_done = b.get("done").and_then(Value::as_bool).unwrap_or(false);
        a_done
            .cmp(&b_done)
            .then_with(|| due_key(a).cmp(&due_key(b)))
            .then_with(|| task_weight(b).cmp(&task_weight(a)))
            .then_with(|| {
                let a_updated = a.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
                let b_updated = b.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
                b_updated.cmp(&a_updated)
            })
    });
    let total = tasks.len();
    tasks.truncate(limit);

    Ok(json!({
        "status": status,
        "tag": tag,
        "count": tasks.len(),
        "total": total,
        "tasks": tasks
    }))
}

fn tasks_get(store: &Store, args: &Value) -> Result<Value, String> {
    let id = arg_str(args, "id").unwrap_or("").trim();
    if id.is_empty() {
        return Err("id 不能为空".into());
    }
    store
        .tasks()
        .into_iter()
        .find(|task| task.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("找不到任务：{id}"))
}

fn tags_list(store: &Store) -> Result<Value, String> {
    Ok(json!({ "tags": store.tags() }))
}

fn call_tool(session: &Session, params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "缺少工具名称".to_string()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match name {
        "notes_search" => notes_search(&session.store, &args),
        "notes_get" => notes_get(&session.store, &args),
        "tasks_list" => tasks_list(&session.store, &args),
        "tasks_get" => tasks_get(&session.store, &args),
        "tags_list" => tags_list(&session.store),
        "notes_create" => notes_create(session, &args),
        "tasks_create" => tasks_create(session, &args),
        _ => Err(format!("未知工具：{name}")),
    };
    match result {
        Ok(value) => Ok(json!({
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }],
            "isError": false
        })),
        Err(message) => Ok(json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true
        })),
    }
}

fn resource_list(store: &Store) -> Value {
    let mut resources = vec![
        json!({
            "uri": "lafei://manifest",
            "name": "Lafei snapshot manifest",
            "description": "Schema version, revision and counts",
            "mimeType": "application/json"
        }),
        json!({
            "uri": "lafei://AGENTS.md",
            "name": "Lafei agent instructions",
            "description": "How to read this snapshot",
            "mimeType": "text/markdown"
        }),
        json!({
            "uri": "lafei://notes",
            "name": "Lafei notes index",
            "description": "All notes with ids, titles, tags and excerpts",
            "mimeType": "application/json"
        }),
        json!({
            "uri": "lafei://tasks",
            "name": "Lafei tasks",
            "description": "All tasks as JSON Lines",
            "mimeType": "application/x-ndjson"
        }),
        json!({
            "uri": "lafei://tags",
            "name": "Lafei tags",
            "description": "Tags with note and task counts",
            "mimeType": "application/json"
        }),
    ];
    for item in store.notes_index() {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            resources.push(json!({
                "uri": format!("lafei://notes/{id}"),
                "name": item.get("title").and_then(Value::as_str).unwrap_or("Untitled note"),
                "description": "Lafei note",
                "mimeType": "text/markdown"
            }));
        }
    }
    json!({ "resources": resources })
}

fn read_resource(store: &Store, params: &Value) -> Result<Value, (i64, String)> {
    let uri = params
        .get("uri")
        .and_then(Value::as_str)
        .ok_or((-32602, "缺少资源 uri".to_string()))?;
    let payload = vec![
        ("lafei://manifest", "manifest.json", "application/json"),
        ("lafei://AGENTS.md", "AGENTS.md", "text/markdown"),
        ("lafei://notes", "notes.index.json", "application/json"),
        ("lafei://tasks", "tasks.jsonl", "application/x-ndjson"),
        ("lafei://tags", "tags.json", "application/json"),
    ];
    for (prefix, file, mime) in payload {
        if uri == prefix {
            let text = store.read(file).ok_or((
                -32002,
                format!("快照中缺少 {file}，请先在 Lafei 中开启智能体访问并导出"),
            ))?;
            return Ok(json!({ "contents": [{ "uri": uri, "mimeType": mime, "text": text }] }));
        }
    }
    if let Some(id) = uri.strip_prefix("lafei://notes/") {
        let (_, markdown) = store
            .note(id)
            .ok_or((-32002, format!("找不到笔记：{id}")))?;
        return Ok(json!({
            "contents": [{ "uri": uri, "mimeType": "text/markdown", "text": markdown }]
        }));
    }
    Err((-32002, format!("未知资源：{uri}")))
}

fn handle_request(
    session: &mut Session,
    method: &str,
    params: &Value,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            // 记录客户端名称，写入队列时作为 client 字段（没有则为 null）
            session.client = initialize_client_name(params);
            Ok(initialize_result(params))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(session, params),
        "resources/list" => Ok(resource_list(&session.store)),
        "resources/templates/list" => Ok(json!({
            "resourceTemplates": [{
                "uriTemplate": "lafei://notes/{id}",
                "name": "Lafei note",
                "description": "A Lafei note as Markdown",
                "mimeType": "text/markdown"
            }]
        })),
        "resources/read" => read_resource(&session.store, params),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "logging/setLevel" => Ok(json!({})),
        _ => Err((-32601, format!("Method not found: {method}"))),
    }
}

fn main() {
    let options = match parse_options() {
        Some(options) => options,
        None => return,
    };
    let mut session = Session {
        store: Store {
            dir: options.data_dir,
        },
        client: None,
    };
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("读取 stdin 失败：{error}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(error) => {
                eprintln!("无法解析 JSON-RPC 消息：{error}");
                continue;
            }
        };
        let Some(id) = message.get("id").cloned() else {
            // notifications/initialized、notifications/cancelled 等不需要响应
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let response = match handle_request(&mut session, &method, &params) {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message }
            }),
        };
        if writeln!(stdout, "{}", response).is_err() {
            break;
        }
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "lafei-mcp-test-{}-{}-{}",
                std::process::id(),
                nanos,
                TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).expect("创建临时目录");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_manifest(dir: &Path, enabled: bool, max_pending: usize) {
        let manifest = json!({
            "schemaVersion": 2,
            "writer": {
                "enabled": enabled,
                "inbox": "inbox",
                "processed": "inbox/done",
                "failed": "inbox/failed",
                "ops": ["notes.create", "tasks.create"],
                "maxPending": max_pending
            }
        });
        fs::write(dir.join("manifest.json"), manifest.to_string()).expect("写入 manifest");
    }

    fn test_store(dir: &Path) -> Store {
        fs::create_dir_all(dir.join("notes")).expect("创建 notes 目录");
        fs::write(
            dir.join("notes.index.json"),
            json!([{
                "id": "note-1",
                "title": "Alpha 笔记",
                "tags": ["alpha"],
                "file": "notes/note-1.md",
                "updatedAt": 1
            }])
            .to_string(),
        )
        .expect("写入 notes.index.json");
        fs::write(
            dir.join("notes/note-1.md"),
            "---\ntitle: Alpha\n---\n\nalpha 正文\n",
        )
        .expect("写入笔记文件");
        let mut tasks =
            json!({"id": "task-1", "title": "任务", "done": false, "tags": []}).to_string();
        tasks.push('\n');
        fs::write(dir.join("tasks.jsonl"), tasks).expect("写入 tasks.jsonl");
        fs::write(dir.join("tags.json"), "[]").expect("写入 tags.json");
        Store {
            dir: dir.to_path_buf(),
        }
    }

    fn enabled_store() -> (TempDir, Store) {
        let temp = TempDir::new();
        let store = test_store(temp.path());
        write_manifest(temp.path(), true, DEFAULT_MAX_PENDING);
        (temp, store)
    }

    fn fast_policy() -> PollPolicy {
        PollPolicy {
            timeout: Duration::from_millis(40),
            interval: Duration::from_millis(5),
        }
    }

    fn slow_policy() -> PollPolicy {
        PollPolicy {
            timeout: Duration::from_millis(1000),
            interval: Duration::from_millis(10),
        }
    }

    fn wait_for_file(path: &Path) {
        for _ in 0..400 {
            if path.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("等待文件出现超时：{}", path.display());
    }

    /// 模拟桌面应用处理请求：合并 result 后移动到 done/ 或 failed/。
    fn settle_request(store: &Store, request_id: &str, success: bool, result: Value) {
        let writer = Writer::load(store).expect("应判定为可写");
        let file_name = format!("{request_id}.json");
        let mut request =
            read_json_file(&writer.inbox.join(&file_name)).expect("队列中应有请求文件");
        request["result"] = result;
        let target = if success {
            &writer.done
        } else {
            &writer.failed
        };
        fs::create_dir_all(target).expect("创建结果目录");
        fs::write(target.join(&file_name), request.to_string()).expect("写入结果文件");
        fs::remove_file(writer.inbox.join(&file_name)).expect("移除请求文件");
    }

    #[test]
    fn request_id_rule_and_generation() {
        assert!(valid_request_id("req-1762345678901-3f9a1c2e"));
        assert!(valid_request_id("abcdefgh"));
        assert!(valid_request_id(&"a".repeat(96)));
        assert!(!valid_request_id("abcdefg"));
        assert!(!valid_request_id(&"a".repeat(97)));
        assert!(!valid_request_id(".abcdefgh"));
        assert!(!valid_request_id("..abcdefgh"));
        assert!(!valid_request_id("req-1..2"));
        assert!(!valid_request_id("abc defgh"));
        assert!(!valid_request_id("abc/defgh"));
        assert!(!valid_request_id("abc+defgh"));
        assert!(valid_request_file_name("req-1762345678901-3f9a1c2e.json"));
        assert!(!valid_request_file_name("req-1762345678901-3f9a1c2e.txt"));

        let generated = generate_request_id();
        let mut parts = generated.split('-');
        assert_eq!(parts.next(), Some("req"));
        let millis = parts.next().expect("毫秒片段");
        let hex = parts.next().expect("hex 片段");
        assert!(parts.next().is_none());
        assert_eq!(millis.len(), 13);
        assert!(millis.chars().all(|value| value.is_ascii_digit()));
        assert_eq!(hex.len(), 8);
        assert!(hex
            .chars()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase()));
        assert!(valid_request_id(&generated));
        assert_ne!(generate_request_id(), generate_request_id());
    }

    #[test]
    fn atomic_write_writes_and_overwrites_without_temp_files() {
        let temp = TempDir::new();
        let inbox = temp.path().join("inbox");
        atomic_write(&inbox, "req-abcdefgh.json", "{\"a\":1}").expect("首次写入");
        assert_eq!(
            fs::read_to_string(inbox.join("req-abcdefgh.json")).unwrap(),
            "{\"a\":1}"
        );
        atomic_write(&inbox, "req-abcdefgh.json", "{\"a\":2}").expect("覆盖写入");
        assert_eq!(
            fs::read_to_string(inbox.join("req-abcdefgh.json")).unwrap(),
            "{\"a\":2}"
        );
        let leftovers: Vec<String> = fs::read_dir(&inbox)
            .expect("读取目录")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn manifest_controls_writer_availability() {
        let temp = TempDir::new();
        let store = test_store(temp.path());
        // manifest 缺失
        assert!(Writer::load(&store).is_none());
        // 旧快照没有 writer 字段
        fs::write(
            temp.path().join("manifest.json"),
            json!({"schemaVersion": 1}).to_string(),
        )
        .unwrap();
        assert!(Writer::load(&store).is_none());
        // writer 关闭
        write_manifest(temp.path(), false, DEFAULT_MAX_PENDING);
        assert!(Writer::load(&store).is_none());
        // manifest 解析失败
        fs::write(temp.path().join("manifest.json"), "not json").unwrap();
        assert!(Writer::load(&store).is_none());
        // writer 开启
        write_manifest(temp.path(), true, 50);
        let writer = Writer::load(&store).expect("应判定为可写");
        assert_eq!(writer.inbox, temp.path().join("inbox"));
        assert_eq!(writer.done, temp.path().join("inbox/done"));
        assert_eq!(writer.failed, temp.path().join("inbox/failed"));
        assert_eq!(writer.max_pending, 50);
    }

    #[test]
    fn tags_are_normalized_and_deduplicated() {
        assert_eq!(
            normalize_tags(Some(&json!(["#alpha", "alpha", " beta ", "##gamma"])))
                .expect("合法标签"),
            vec!["alpha", "beta", "gamma"]
        );
        assert!(normalize_tags(None).expect("默认空数组").is_empty());
        assert!(normalize_tags(Some(&json!({"tag": "x"}))).is_err());
        assert!(normalize_tags(Some(&json!(["ok", 3]))).is_err());
        assert!(normalize_tags(Some(&json!(["#"]))).is_err());
        assert!(normalize_tags(Some(&json!(["x".repeat(MAX_TAG_CHARS + 1)]))).is_err());
        let longest = "x".repeat(MAX_TAG_CHARS);
        assert_eq!(
            normalize_tags(Some(&json!([longest])))
                .expect("64 字符标签")
                .len(),
            1
        );
        let too_many: Vec<String> = (0..=MAX_TAGS).map(|index| format!("tag{index}")).collect();
        assert!(normalize_tags(Some(&json!(too_many))).is_err());
    }

    #[test]
    fn note_validation_enforces_contract() {
        assert!(validate_note_payload(&json!({})).is_err());
        assert!(validate_note_payload(&json!({"title": "   "})).is_err());
        assert!(validate_note_payload(&json!({"title": "x".repeat(MAX_TITLE_CHARS + 1)})).is_err());
        let payload = validate_note_payload(&json!({"title": "  标题  "})).expect("合法标题");
        assert_eq!(payload["title"], "标题");
        assert_eq!(payload["content"], "");
        assert_eq!(payload["tags"], json!([]));
        assert_eq!(payload["pinned"], false);

        let too_long_content = "x".repeat(MAX_NOTE_CONTENT_CHARS + 1);
        assert!(
            validate_note_payload(&json!({"title": "标题", "content": too_long_content})).is_err()
        );
        let max_content = "x".repeat(MAX_NOTE_CONTENT_CHARS);
        assert!(validate_note_payload(&json!({"title": "标题", "content": max_content})).is_ok());
        assert!(validate_note_payload(&json!({"title": "标题", "pinned": "yes"})).is_err());
        assert!(validate_note_payload(&json!({"title": "标题", "tags": ["ok", 3]})).is_err());
    }

    #[test]
    fn task_validation_enforces_contract() {
        let temp = TempDir::new();
        let store = test_store(temp.path());

        for value in [
            "2026-02-29",
            "2024-02-30",
            "2026-13-01",
            "2026-00-10",
            "2026-04-31",
            "2026-1-1",
            "2026/01/01",
            "",
        ] {
            assert!(
                validate_task_payload(&store, &json!({"title": "任务", "dueDate": value})).is_err(),
                "应拒绝 {value}"
            );
        }
        for value in ["2024-02-29", "2026-12-31", "2000-02-29", "1900-02-28"] {
            assert!(
                validate_task_payload(&store, &json!({"title": "任务", "dueDate": value})).is_ok(),
                "应接受 {value}"
            );
        }

        let defaults = validate_task_payload(&store, &json!({"title": "任务"})).expect("默认值");
        assert_eq!(defaults["dueDate"], json!(null));
        assert_eq!(defaults["priority"], "medium");
        assert_eq!(defaults["description"], "");
        assert_eq!(defaults["noteId"], json!(null));

        let explicit_null = validate_task_payload(
            &store,
            &json!({"title": "任务", "dueDate": null, "noteId": null}),
        )
        .expect("null 合法");
        assert_eq!(explicit_null["dueDate"], json!(null));

        assert!(
            validate_task_payload(&store, &json!({"title": "任务", "priority": "urgent"})).is_err()
        );
        let high = validate_task_payload(&store, &json!({"title": "任务", "priority": "high"}))
            .expect("high 合法");
        assert_eq!(high["priority"], "high");

        assert!(
            validate_task_payload(&store, &json!({"title": "任务", "noteId": "missing-note"}))
                .is_err()
        );
        let with_note =
            validate_task_payload(&store, &json!({"title": "任务", "noteId": "note-1"}))
                .expect("存在的 noteId");
        assert_eq!(with_note["noteId"], "note-1");

        let too_long = "x".repeat(MAX_TASK_DESCRIPTION_CHARS + 1);
        assert!(
            validate_task_payload(&store, &json!({"title": "任务", "description": too_long}))
                .is_err()
        );
        assert!(validate_task_payload(&store, &json!({"title": "   "})).is_err());
        assert!(requested_request_id(&json!({"requestId": "bad"})).is_err());
        assert!(requested_request_id(&json!({"requestId": "..abcdefgh"})).is_err());
        assert_eq!(
            requested_request_id(&json!({"requestId": "req-abcdefgh"})).expect("合法 requestId"),
            Some("req-abcdefgh".to_string())
        );
        assert!(requested_request_id(&json!({})).expect("缺省").is_none());
    }

    #[test]
    fn write_creates_queue_file_with_contract_shape() {
        let (_temp, store) = enabled_store();
        let result = submit_write(
            &store,
            Some("codex"),
            WriteOp::NOTES,
            json!({"title": "标题", "content": "", "tags": ["alpha"], "pinned": false}),
            None,
            fast_policy(),
        )
        .expect("应返回 queued");
        assert_eq!(result["status"], "queued");
        assert_eq!(result["message"], QUEUED_MESSAGE);
        let request_id = result["requestId"].as_str().expect("requestId").to_string();
        let writer = Writer::load(&store).expect("应判定为可写");
        let request =
            read_json_file(&writer.inbox.join(format!("{request_id}.json"))).expect("队列请求文件");
        assert_eq!(request["schemaVersion"], WRITE_SCHEMA_VERSION);
        assert_eq!(request["requestId"], request_id);
        assert_eq!(request["op"], "notes.create");
        assert_eq!(request["client"], "codex");
        assert!(request["createdAt"].as_u64().unwrap_or(0) > 0);
        assert_eq!(request["payload"]["title"], "标题");
        assert_eq!(request["payload"]["tags"], json!(["alpha"]));
        assert_eq!(pending_count(&writer), 1);
    }

    #[test]
    fn write_respects_request_timeout_when_app_does_not_run() {
        let (_temp, store) = enabled_store();
        let result = submit_write(
            &store,
            None,
            WriteOp::NOTES,
            json!({"title": "标题"}),
            None,
            fast_policy(),
        )
        .expect("应返回 queued");
        assert_eq!(result["status"], "queued");
        assert_eq!(result["message"], QUEUED_MESSAGE);
    }

    #[test]
    fn write_returns_created_after_app_applies_request() {
        let (_temp, store) = enabled_store();
        let request_id = "req-test-applied-0001".to_string();
        let worker_store = Store {
            dir: store.dir.clone(),
        };
        let worker_id = request_id.clone();
        let handle = std::thread::spawn(move || {
            let writer = Writer::load(&worker_store).expect("应判定为可写");
            wait_for_file(&writer.inbox.join(format!("{worker_id}.json")));
            settle_request(
                &worker_store,
                &worker_id,
                true,
                json!({
                    "status": "applied",
                    "appliedAt": 1,
                    "entityKind": "note",
                    "entityId": "note-created",
                    "title": "标题"
                }),
            );
        });
        let result = submit_write(
            &store,
            Some("codex"),
            WriteOp::NOTES,
            json!({"title": "标题"}),
            Some(request_id.clone()),
            slow_policy(),
        )
        .expect("应返回 created");
        handle.join().expect("模拟应用线程失败");
        assert_eq!(result["status"], "created");
        assert_eq!(result["requestId"], request_id);
        assert_eq!(result["kind"], "note");
        assert_eq!(result["id"], "note-created");
        assert_eq!(result["title"], "标题");
    }

    #[test]
    fn write_returns_error_when_app_rejects_request() {
        let (_temp, store) = enabled_store();
        let request_id = "req-test-rejected-001".to_string();
        let worker_store = Store {
            dir: store.dir.clone(),
        };
        let worker_id = request_id.clone();
        let handle = std::thread::spawn(move || {
            let writer = Writer::load(&worker_store).expect("应判定为可写");
            wait_for_file(&writer.inbox.join(format!("{worker_id}.json")));
            settle_request(
                &worker_store,
                &worker_id,
                false,
                json!({
                    "status": "rejected",
                    "appliedAt": 1,
                    "error": "标题不合规"
                }),
            );
        });
        let error = submit_write(
            &store,
            None,
            WriteOp::TASKS,
            json!({"title": "标题"}),
            Some(request_id),
            slow_policy(),
        )
        .expect_err("应返回错误");
        handle.join().expect("模拟应用线程失败");
        assert!(error.contains("标题不合规"), "错误文案：{error}");
        assert!(error.contains("拒绝"), "错误文案：{error}");
    }

    #[test]
    fn writes_are_disabled_without_writer_enabled() {
        let temp = TempDir::new();
        let store = test_store(temp.path());
        write_manifest(temp.path(), false, DEFAULT_MAX_PENDING);
        let error = submit_write(
            &store,
            None,
            WriteOp::NOTES,
            json!({"title": "标题"}),
            None,
            fast_policy(),
        )
        .expect_err("应拒绝写入");
        assert!(error.contains("未开启智能体写入"), "错误文案：{error}");
        assert!(!temp.path().join("inbox").exists());

        fs::write(
            temp.path().join("manifest.json"),
            json!({"schemaVersion": 1}).to_string(),
        )
        .unwrap();
        let error = submit_write(
            &store,
            None,
            WriteOp::NOTES,
            json!({"title": "标题"}),
            None,
            fast_policy(),
        )
        .expect_err("旧快照应拒绝写入");
        assert!(error.contains("未开启智能体写入"), "错误文案：{error}");
    }

    #[test]
    fn queue_full_is_rejected() {
        let temp = TempDir::new();
        let store = test_store(temp.path());
        write_manifest(temp.path(), true, 2);
        let writer = Writer::load(&store).expect("应判定为可写");
        fs::create_dir_all(&writer.inbox).unwrap();
        for index in 0..2 {
            let request = json!({"op": "notes.create", "createdAt": index + 1});
            fs::write(
                writer.inbox.join(format!("req-queue-{index:04}.json")),
                request.to_string(),
            )
            .unwrap();
        }
        // 无法解析的坏文件不计入待处理数（与桌面端 pendingRequests 口径一致）
        fs::write(writer.inbox.join("req-queue-broken.json"), "not json").unwrap();
        assert_eq!(pending_count(&writer), 2);
        let error = submit_write(
            &store,
            None,
            WriteOp::NOTES,
            json!({"title": "标题"}),
            None,
            fast_policy(),
        )
        .expect_err("队列已满应拒绝");
        assert!(error.contains("队列已满"), "错误文案：{error}");
        assert_eq!(pending_count(&writer), 2);
    }

    #[test]
    fn repeated_request_id_reuses_done_result() {
        let (_temp, store) = enabled_store();
        let writer = Writer::load(&store).expect("应判定为可写");
        let request_id = "req-idempotent-done";
        fs::create_dir_all(&writer.done).unwrap();
        fs::write(
            writer.done.join(format!("{request_id}.json")),
            json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "op": "notes.create",
                "client": null,
                "createdAt": 1,
                "payload": {"title": "已有"},
                "result": {
                    "status": "applied",
                    "appliedAt": 2,
                    "entityKind": "note",
                    "entityId": "note-existing",
                    "title": "已有"
                }
            })
            .to_string(),
        )
        .unwrap();
        let result = submit_write(
            &store,
            None,
            WriteOp::NOTES,
            json!({"title": "重复"}),
            Some(request_id.to_string()),
            fast_policy(),
        )
        .expect("应返回 created");
        assert_eq!(result["status"], "created");
        assert_eq!(result["id"], "note-existing");
        assert!(!writer.inbox.join(format!("{request_id}.json")).exists());
        assert_eq!(pending_count(&writer), 0);
    }

    #[test]
    fn repeated_request_id_does_not_duplicate_pending_request() {
        let (_temp, store) = enabled_store();
        let writer = Writer::load(&store).expect("应判定为可写");
        fs::create_dir_all(&writer.inbox).unwrap();
        let request_id = "req-idempotent-pending";
        let original = json!({
            "schemaVersion": 1,
            "requestId": request_id,
            "op": "notes.create",
            "client": null,
            "createdAt": 1,
            "payload": {"title": "原始"}
        });
        fs::write(
            writer.inbox.join(format!("{request_id}.json")),
            original.to_string(),
        )
        .unwrap();
        let result = submit_write(
            &store,
            None,
            WriteOp::NOTES,
            json!({"title": "重复"}),
            Some(request_id.to_string()),
            fast_policy(),
        )
        .expect("应返回 queued");
        assert_eq!(result["status"], "queued");
        assert_eq!(result["requestId"], request_id);
        assert_eq!(pending_count(&writer), 1);
        let saved =
            read_json_file(&writer.inbox.join(format!("{request_id}.json"))).expect("原请求文件");
        assert_eq!(saved["payload"]["title"], "原始");
    }

    #[test]
    fn repeated_request_id_reuses_failed_result() {
        let (_temp, store) = enabled_store();
        let writer = Writer::load(&store).expect("应判定为可写");
        let request_id = "req-idempotent-failed";
        fs::create_dir_all(&writer.failed).unwrap();
        fs::write(
            writer.failed.join(format!("{request_id}.json")),
            json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "op": "tasks.create",
                "client": null,
                "createdAt": 1,
                "payload": {"title": "非法"},
                "result": {"status": "rejected", "appliedAt": 2, "error": "标题不能为空"}
            })
            .to_string(),
        )
        .unwrap();
        let error = submit_write(
            &store,
            None,
            WriteOp::TASKS,
            json!({"title": "重复"}),
            Some(request_id.to_string()),
            fast_policy(),
        )
        .expect_err("应返回错误");
        assert!(error.contains("标题不能为空"), "错误文案：{error}");
        assert!(!writer.inbox.join(format!("{request_id}.json")).exists());
    }

    #[test]
    fn tool_list_exposes_write_tools() {
        let tools = tool_definitions();
        let tools = tools.as_array().expect("工具数组");
        for name in ["notes_create", "tasks_create"] {
            let tool = tools
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap_or_else(|| panic!("缺少工具 {name}"));
            assert_eq!(tool["annotations"]["readOnlyHint"], false);
            assert_eq!(tool["annotations"]["destructiveHint"], false);
            assert_eq!(tool["annotations"]["openWorldHint"], false);
            assert_eq!(tool["inputSchema"]["required"], json!(["title"]));
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
        for name in [
            "notes_search",
            "notes_get",
            "tasks_list",
            "tasks_get",
            "tags_list",
        ] {
            assert!(
                tools.iter().any(|tool| tool["name"] == name),
                "缺少只读工具 {name}"
            );
        }
    }

    #[test]
    fn initialize_remembers_client_name() {
        let temp = TempDir::new();
        let store = test_store(temp.path());
        let mut session = Session {
            store,
            client: None,
        };
        let result = handle_request(
            &mut session,
            "initialize",
            &json!({
                "protocolVersion": "2025-06-18",
                "clientInfo": {"name": "codex", "version": "1.0.0"}
            }),
        )
        .expect("initialize 成功");
        assert_eq!(session.client.as_deref(), Some("codex"));
        assert!(result["instructions"]
            .as_str()
            .unwrap_or_default()
            .contains("notes_create"));

        let mut anonymous = Session {
            store: test_store(&temp.path().join("other")),
            client: None,
        };
        handle_request(&mut anonymous, "initialize", &json!({})).expect("无 clientInfo");
        assert!(anonymous.client.is_none());
    }

    #[test]
    fn call_tool_reports_denied_write_as_tool_error() {
        let temp = TempDir::new();
        let store = test_store(temp.path());
        write_manifest(temp.path(), false, DEFAULT_MAX_PENDING);
        let session = Session {
            store,
            client: None,
        };
        let result = call_tool(
            &session,
            &json!({"name": "notes_create", "arguments": {"title": "标题"}}),
        )
        .expect("tools/call 本身成功");
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .contains("未开启智能体写入"));
    }
}
