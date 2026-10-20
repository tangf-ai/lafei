import { db } from "../db";
import type { LogseqScan, LogseqTaskPreview, Priority, Task } from "../types";
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
  return {
    id: item.id,
    title: item.title.trim(),
    description: item.description,
    noteId: null,
    dueDate: item.dueDate,
    priority,
    done: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function importLogseqTasks(scan: LogseqScan): Promise<{ added: number; skipped: number }> {
  const existing = await db.tasks.toArray();
  const knownIds = new Set(existing.map((task) => task.id));
  const knownTitles = new Set(existing.map((task) => normalizedTitle(task.title)));
  const now = Date.now();
  const tasks: Task[] = [];
  let skipped = 0;

  for (const item of scan.tasks) {
    const title = item.title.trim();
    const normalized = normalizedTitle(title);
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
