import type { Note, Task } from "../types";

/** 一条笔记 / 任务最多保存的标签数 */
export const MAX_TAGS = 12;

/** 把用户输入整理成标签：去掉 #、空白折叠成 -，并限制长度 */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .replace(/[\s,，、;；]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "")
    .slice(0, 24);
}

export function sameTag(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/** 兼容旧数据：即使对象上没有 tags，也总是返回可遍历的字符串数组 */
export function tagsOf(entity: { tags?: unknown } | null | undefined): string[] {
  const tags = entity?.tags;
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function hasTag(entity: { tags?: unknown } | null | undefined, tag: string): boolean {
  if (!tag) return false;
  return tagsOf(entity).some((item) => sameTag(item, tag));
}

export function addTag(tags: string[], raw: string, max = MAX_TAGS): string[] {
  const value = normalizeTag(raw);
  if (!value) return tags;
  if (tags.some((tag) => sameTag(tag, value))) return tags;
  return [...tags, value].slice(0, max);
}

export function removeTag(tags: string[], target: string): string[] {
  return tags.filter((tag) => !sameTag(tag, target));
}

export interface TagCount {
  tag: string;
  notes: number;
  tasks: number;
  openTasks: number;
  total: number;
  updatedAt: number;
}

/** 汇总笔记与任务共用的标签；同一个标签只出现一次，大小写差异合并 */
export function collectTagCounts(notes: Note[], tasks: Task[]): TagCount[] {
  const byKey = new Map<string, TagCount>();
  const ensure = (tag: string, updatedAt: number) => {
    const key = tag.toLocaleLowerCase();
    let entry = byKey.get(key);
    if (!entry) {
      entry = { tag, notes: 0, tasks: 0, openTasks: 0, total: 0, updatedAt: 0 };
      byKey.set(key, entry);
    }
    entry.updatedAt = Math.max(entry.updatedAt, updatedAt);
    return entry;
  };

  for (const note of notes) {
    const seen = new Set<string>();
    for (const tag of tagsOf(note)) {
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = ensure(tag, note.updatedAt);
      entry.notes += 1;
      entry.total += 1;
    }
  }

  for (const task of tasks) {
    const seen = new Set<string>();
    for (const tag of tagsOf(task)) {
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = ensure(tag, task.updatedAt);
      entry.tasks += 1;
      entry.total += 1;
      if (!task.done) entry.openTasks += 1;
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.total - a.total || a.tag.localeCompare(b.tag, "zh-Hans-CN"),
  );
}

// 标签必须出现在行首、空白或常见标点之后；这样可以避开 URL fragment（.../#setup）
// 和 C# 这类词内井号。纯数字（如 “Fix #42” 的问题编号）也不当作标签。
const HASHTAG_PATTERN = /(^|[\s(（【,，、;；:：>"'“”‘’])#(?:\[\[([^\]]+)\]\]|([\p{L}\p{N}_/-]+))/gu;

function matchedTag(multi: string | undefined, plain: string | undefined): string {
  const tag = normalizeTag(multi ?? plain ?? "");
  if (!tag || /^\d+$/.test(tag)) return "";
  return tag;
}

/** 从一段文本里提取 #标签（支持 #[[多词标签]]），用于 Logseq 导入等场景 */
export function extractHashtags(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(HASHTAG_PATTERN)) {
    const tag = matchedTag(match[2], match[3]);
    if (tag && !found.some((item) => sameTag(item, tag))) found.push(tag);
  }
  return found.slice(0, MAX_TAGS);
}

/** 去掉文本里的 #标签，并把多余空白收好 */
export function stripHashtags(text: string): string {
  return text
    .replace(HASHTAG_PATTERN, (whole: string, prefix: string, multi?: string, plain?: string) => {
      const tag = matchedTag(multi, plain);
      return tag ? prefix : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}
