import { db } from "../db";
import type { LogseqScan, LogseqTaskPreview, Priority, Task } from "../types";
import { extractHashtags, stripHashtags } from "./tags";
import { dayKey } from "./util";

export async function scanLogseqGraph(path: string): Promise<LogseqScan> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LogseqScan>("scan_logseq_tasks", { path, today: dayKey() });
}

function normalizedTitle(title: string) {
  return title.toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
}

function toTask(item: LogseqTaskPreview, now: number): Task {
  const priority: Priority = ["high", "medium", "low"].includes(item.priority)
    ? item.priority
    : "medium";
  // Logseq 任务标题里的 #标签 变成 Lafei 的任务标签，标题本身保持干净
  const tags = extractHashtags(item.title);
  const cleaned = stripHashtags(item.title);
  return {
    id: item.id,
    title: (cleaned || item.title).trim(),
    description: item.description,
    noteId: null,
    dueDate: item.dueDate,
    priority,
    tags,
    done: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function importLogseqTasks(scan: LogseqScan): Promise<{ added: number; skipped: number }> {
  const existing = await db.tasks.toArray();
  const knownIds = new Set(existing.map((task) => task.id));
  // 旧版本导入的任务标题里可能还留着 #标签，比较时把两边都去掉标签
  const knownTitles = new Set(
    existing.flatMap((task) => [normalizedTitle(task.title), normalizedTitle(stripHashtags(task.title))]).filter(Boolean),
  );
  const now = Date.now();
  const tasks: Task[] = [];
  let skipped = 0;

  for (const item of scan.tasks) {
    const title = item.title.trim();
    // 存进去的是去掉 #标签 之后的标题，去重时也要用同一份标题比较
    const normalized = normalizedTitle(stripHashtags(title).trim() || title);
    if (!title || knownIds.has(item.id) || knownTitles.has(normalized)) {
      skipped += 1;
      continue;
    }
    tasks.push(toTask(item, now));
    knownIds.add(item.id);
    knownTitles.add(normalized);
  }

  if (tasks.length) await db.tasks.bulkAdd(tasks);
  return { added: tasks.length, skipped };
}
