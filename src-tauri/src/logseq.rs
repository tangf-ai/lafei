use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogseqTask {
    pub id: String,
    pub title: String,
    pub description: String,
    pub due_date: Option<String>,
    pub priority: String,
    pub source_page: String,
    pub source_file: String,
    pub source_line: usize,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogseqScan {
    pub graph_path: String,
    pub graph_name: String,
    pub scanned_files: usize,
    pub open_count: usize,
    pub completed_count: usize,
    pub tasks: Vec<LogseqTask>,
}

fn task_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^([ \t]*)[-*+][ \t]+(TODO|DOING|NOW|LATER|WAITING|DONE|CANCELED|CANCELLED)[ \t]*(.*)$")
            .expect("valid task regex")
    })
}

fn priority_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[#([A-Za-z])\]").expect("valid priority regex"))
}

fn deadline_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)DEADLINE:\s*<(\d{4})-(\d{1,2})-(\d{1,2})").expect("valid deadline regex")
    })
}

fn scheduled_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)SCHEDULED:\s*<(\d{4})-(\d{1,2})-(\d{1,2})").expect("valid scheduled regex")
    })
}

fn natural_due_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:截止|deadline|due)[：:\s]*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2})",
        )
        .expect("valid due date regex")
    })
}

fn inline_meta_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)\s*(?:SCHEDULED|DEADLINE):\s*<[^>]+>")
            .expect("valid inline property regex")
    })
}

fn indent_of(line: &str) -> usize {
    line.chars()
        .take_while(|ch| *ch == ' ' || *ch == '\t')
        .count()
}

fn is_block_start(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("- ")
        || trimmed.starts_with("* ")
        || trimmed.starts_with("+ ")
        || trimmed.starts_with('#')
}

fn normalized_date(year: usize, month: usize, day: usize) -> Option<String> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn full_date_match(captures: &regex::Captures<'_>) -> Option<String> {
    let year = captures.get(1)?.as_str().parse::<usize>().ok()?;
    let month = captures.get(2)?.as_str().parse::<usize>().ok()?;
    let day = captures.get(3)?.as_str().parse::<usize>().ok()?;
    normalized_date(year, month, day)
}

fn natural_date_match(raw: &str, current_year: usize) -> Option<String> {
    if current_year == 0 {
        return None;
    }
    let parts: Vec<&str> = raw.split(['-', '/', '.']).collect();
    match parts.as_slice() {
        [year, month, day] => {
            normalized_date(year.parse().ok()?, month.parse().ok()?, day.parse().ok()?)
        }
        [month, day] => normalized_date(current_year, month.parse().ok()?, day.parse().ok()?),
        _ => None,
    }
}

fn due_date(block: &[&str], current_year: usize) -> Option<String> {
    for line in block {
        if let Some(captures) = deadline_re().captures(line) {
            if let Some(date) = full_date_match(&captures) {
                return Some(date);
            }
        }
    }
    for line in block {
        if let Some(captures) = scheduled_re().captures(line) {
            if let Some(date) = full_date_match(&captures) {
                return Some(date);
            }
        }
    }
    for line in block.iter().skip(1) {
        if let Some(captures) = natural_due_re().captures(line) {
            if let Some(raw) = captures.get(1) {
                if let Some(date) = natural_date_match(raw.as_str(), current_year) {
                    return Some(date);
                }
            }
        }
    }
    None
}

fn clean_child_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Some(String::new());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("scheduled:")
        || lower.starts_with("deadline:")
        || lower.starts_with(":logbook:")
        || lower.starts_with(":end:")
        || lower.starts_with(":properties:")
        || lower.starts_with(":id:")
        || lower.starts_with("collapsed::")
        || lower.starts_with("id::")
        || lower.starts_with("template::")
        || lower.starts_with("background-color::")
        || lower.starts_with("created-at::")
        || lower.starts_with("updated-at::")
    {
        return None;
    }
    let without_bullet = if let Some(rest) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
    {
        rest
    } else {
        trimmed
    };
    Some(without_bullet.to_string())
}

fn description(block: &[&str], page: &str, relative: &str, line: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    for child in block.iter().skip(1) {
        if let Some(cleaned) = clean_child_line(child) {
            if cleaned.is_empty() {
                if parts.last().map(|part| !part.is_empty()).unwrap_or(false) {
                    parts.push(String::new());
                }
            } else {
                parts.push(cleaned);
            }
        }
    }
    while parts.last().map(|part| part.is_empty()).unwrap_or(false) {
        parts.pop();
    }
    let body = parts.join("\n").trim().to_string();
    let source = format!("来源：Logseq · {page} · {relative}:{line}");
    if body.is_empty() {
        source
    } else {
        format!("{body}\n\n{source}")
    }
}

fn fnv_id(relative: &str, line: usize, title: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in format!("{relative}:{line}:{title}").as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("logseq-{hash:016x}")
}

fn page_title(lines: &[&str], path: &Path) -> String {
    for line in lines.iter().take(20) {
        if let Some(value) = line.strip_prefix("title::") {
            let value = value.trim();
            if !value.is_empty() {
                return value.to_string();
            }
        }
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Logseq");
    if stem.len() == 10 && stem.as_bytes()[4] == b'_' && stem.as_bytes()[7] == b'_' {
        return stem.replace('_', "-");
    }
    stem.replace("___", " / ")
}

fn parse_file(
    relative: &str,
    content: &str,
    current_year: usize,
    tasks: &mut Vec<LogseqTask>,
    completed: &mut usize,
) {
    let lines: Vec<&str> = content.lines().collect();
    let page = page_title(&lines, Path::new(relative));
    for (index, line) in lines.iter().enumerate() {
        let Some(captures) = task_re().captures(line) else {
            continue;
        };
        let indent = captures.get(1).map(|m| indent_of(m.as_str())).unwrap_or(0);
        let status = captures.get(2).map(|m| m.as_str()).unwrap_or("TODO");
        if matches!(status, "DONE" | "CANCELED" | "CANCELLED") {
            *completed += 1;
            continue;
        }

        let raw_title = captures.get(3).map(|m| m.as_str()).unwrap_or("").trim();
        let priority = priority_re()
            .captures(raw_title)
            .and_then(|captures| captures.get(1))
            .map(|value| match value.as_str().to_ascii_uppercase().as_str() {
                "A" => "high",
                "B" => "medium",
                "C" => "low",
                _ => "medium",
            })
            .unwrap_or("medium")
            .to_string();
        let title = inline_meta_re()
            .replace_all(&priority_re().replace_all(raw_title, ""), "")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }

        let mut end = index + 1;
        while end < lines.len() {
            let next = lines[end];
            if !next.trim().is_empty() && indent_of(next) <= indent && is_block_start(next) {
                break;
            }
            end += 1;
        }
        let block = &lines[index..end];
        tasks.push(LogseqTask {
            id: fnv_id(relative, index + 1, &title),
            title,
            description: description(block, &page, relative, index + 1),
            due_date: due_date(block, current_year),
            priority,
            source_page: page.clone(),
            source_file: relative.to_string(),
            source_line: index + 1,
            status: status.to_string(),
        });
    }
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | "logseq" | "bak" | ".recycle" | "assets" | "whiteboards" | "node_modules"
    )
}

fn walk_files(dir: &Path, root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if !should_skip_dir(name) {
                walk_files(&path, root, files);
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if extension == "md" || extension == "org" {
            if path.strip_prefix(root).is_ok() {
                files.push(path);
            }
        }
    }
}

pub fn scan(root: &str, today: &str) -> Result<LogseqScan, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|_| "找不到这个 Logseq graph 文件夹".to_string())?;
    if !root_path.is_dir() {
        return Err("请选择 Logseq graph 文件夹".into());
    }

    let pages = root_path.join("pages");
    let journals = root_path.join("journals");
    let mut files = Vec::new();
    if pages.is_dir() {
        walk_files(&pages, &root_path, &mut files);
    }
    if journals.is_dir() {
        walk_files(&journals, &root_path, &mut files);
    }
    if files.is_empty() {
        return Err("这个文件夹里没有找到 pages/ 或 journals/，请选择 Logseq graph 根目录".into());
    }
    files.sort();

    let current_year = today
        .split('-')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let graph_name = root_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Logseq")
        .to_string();
    let mut tasks = Vec::new();
    let mut completed = 0;
    let mut scanned = 0;

    for path in files {
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        scanned += 1;
        let relative = path
            .strip_prefix(&root_path)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        parse_file(
            &relative,
            &content,
            current_year,
            &mut tasks,
            &mut completed,
        );
    }

    let open_count = tasks.len();
    Ok(LogseqScan {
        graph_path: root_path.to_string_lossy().to_string(),
        graph_name,
        scanned_files: scanned,
        open_count,
        completed_count: completed,
        tasks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("lafei-logseq-test-{stamp}"));
        fs::create_dir_all(root.join("journals")).unwrap();
        fs::create_dir_all(root.join("pages")).unwrap();
        fs::create_dir_all(root.join("logseq/bak/journals")).unwrap();
        fs::write(
            root.join("journals/2026_10_20.md"),
            "- TODO [#A] 准备交流材料\n- DONE 已完成的任务\n- LATER 以后再看\n",
        )
        .unwrap();
        fs::write(
            root.join("pages/LLM.md"),
            "title:: 模型服务\n\n- TODO [#C] 检查自动扣费\n  - 截止 10-23，记得核对\n",
        )
        .unwrap();
        fs::write(
            root.join("logseq/bak/journals/2026_10_20.md"),
            "- TODO 备份不应该导入\n",
        )
        .unwrap();
        root
    }

    #[test]
    fn scans_open_tasks_and_skips_backups() {
        let root = fixture_root();
        let result = scan(root.to_str().unwrap(), "2026-10-20").unwrap();
        assert_eq!(result.open_count, 3);
        assert_eq!(result.completed_count, 1);
        assert_eq!(result.scanned_files, 2);

        let urgent = result
            .tasks
            .iter()
            .find(|task| task.title == "准备交流材料")
            .unwrap();
        assert_eq!(urgent.priority, "high");
        assert_eq!(urgent.source_page, "2026-10-20");
        assert_eq!(urgent.due_date, None);

        let llm = result
            .tasks
            .iter()
            .find(|task| task.title == "检查自动扣费")
            .unwrap();
        assert_eq!(llm.priority, "low");
        assert_eq!(llm.due_date.as_deref(), Some("2026-10-23"));
        assert_eq!(llm.source_page, "模型服务");
        assert!(llm.description.contains("记得核对"));
        assert!(llm.description.contains("LLM.md"));

        let later = result
            .tasks
            .iter()
            .find(|task| task.title == "以后再看")
            .unwrap();
        assert_eq!(later.status, "LATER");
        assert_eq!(later.due_date, None);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_explicit_deadline_before_scheduled() {
        let block = [
            "- TODO 写方案",
            "  SCHEDULED: <2026-10-21 Wed>",
            "  DEADLINE: <2026-10-25 Sun>",
        ];
        assert_eq!(due_date(&block, 2026).as_deref(), Some("2026-10-25"));
    }

    #[test]
    fn rejects_a_folder_that_is_not_a_graph() {
        let root = std::env::temp_dir().join(format!("lafei-empty-graph-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        assert!(scan(root.to_str().unwrap(), "2026-10-20").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
