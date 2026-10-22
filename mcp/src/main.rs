use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Component, Path, PathBuf};

const FALLBACK_PROTOCOL: &str = "2025-06-18";
const SERVER_NAME: &str = "lafei-mcp";

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
        "lafei-mcp {}\n\nRead-only MCP server for Lafei notes and tasks.\n\nUsage:\n  lafei-mcp [--data-dir <path>]\n\nOptions:\n  --data-dir <path>   Lafei agent snapshot directory (default: platform app data dir)\n  -h, --help          Show this help\n  -V, --version       Show version\n\nEnvironment:\n  LAFEI_AGENT_DIR     Override the snapshot directory\n",
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
        "instructions": "Lafei is a local-first notes and tasks app. This server is read-only: use notes_search / notes_get / tasks_list / tasks_get / tags_list, and cite note ids or titles when answering."
    })
}

fn tool_definitions() -> Value {
    let read_only = json!({ "readOnlyHint": true, "openWorldHint": false, "idempotentHint": true });
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

fn call_tool(store: &Store, params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "缺少工具名称".to_string()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let result = match name {
        "notes_search" => notes_search(store, &args),
        "notes_get" => notes_get(store, &args),
        "tasks_list" => tasks_list(store, &args),
        "tasks_get" => tasks_get(store, &args),
        "tags_list" => tags_list(store),
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

fn handle_request(store: &Store, method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(initialize_result(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(store, params),
        "resources/list" => Ok(resource_list(store)),
        "resources/templates/list" => Ok(json!({
            "resourceTemplates": [{
                "uriTemplate": "lafei://notes/{id}",
                "name": "Lafei note",
                "description": "A Lafei note as Markdown",
                "mimeType": "text/markdown"
            }]
        })),
        "resources/read" => read_resource(store, params),
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
    let store = Store {
        dir: options.data_dir,
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
        let response = match handle_request(&store, &method, &params) {
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
