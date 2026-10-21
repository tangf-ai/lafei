import {
  differenceInCalendarDays,
  format,
  isToday,
  isYesterday,
  parseISO,
  startOfDay,
} from "date-fns";
import { zhCN } from "date-fns/locale";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function dayKey(date = new Date()) {
  return format(date, "yyyy-MM-dd");
}

export function dateFromDayKey(key: string) {
  return parseISO(`${key}T12:00:00`);
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function longDate(date = new Date()) {
  return format(date, "M月d日 · EEEE", { locale: zhCN });
}

export function shortDate(date = new Date()) {
  return format(date, "M月d日", { locale: zhCN });
}

export function updatedLabel(timestamp: number) {
  const date = new Date(timestamp);
  if (isToday(date)) return `今天 ${format(date, "HH:mm")}`;
  if (isYesterday(date)) return "昨天";
  if (differenceInCalendarDays(new Date(), date) < 7) return format(date, "EEEE", { locale: zhCN });
  return format(date, "M月d日", { locale: zhCN });
}

export function dayGroupLabel(key: string) {
  const date = dateFromDayKey(key);
  const diff = differenceInCalendarDays(date, startOfDay(new Date()));
  if (diff === 0) return "今天";
  if (diff === -1) return "昨天";
  if (diff > -7) return format(date, "EEEE", { locale: zhCN });
  return format(date, "M月d日", { locale: zhCN });
}

export function dueLabel(key: string | null): { label: string; tone: "overdue" | "today" | "soon" | "later" | "none" } {
  if (!key) return { label: "无日期", tone: "none" };
  const date = dateFromDayKey(key);
  const today = startOfDay(new Date());
  const diff = differenceInCalendarDays(date, today);
  if (diff < 0) return { label: diff === -1 ? "昨天逾期" : `逾期 ${Math.abs(diff)} 天`, tone: "overdue" };
  if (diff === 0) return { label: "今天", tone: "today" };
  if (diff === 1) return { label: "明天", tone: "soon" };
  if (diff > 1 && diff < 7) return { label: format(date, "EEEE", { locale: zhCN }), tone: "soon" };
  return { label: format(date, "M月d日", { locale: zhCN }), tone: "later" };
}

export function remainingLabel(key: string | null): {
  label: string;
  tone: "overdue" | "today" | "soon" | "later" | "none";
  days: number | null;
} {
  if (!key) return { label: "未安排", tone: "none", days: null };
  const days = differenceInCalendarDays(dateFromDayKey(key), startOfDay(new Date()));
  if (days < 0) {
    return {
      label: days === -1 ? "已逾期 1 天" : `已逾期 ${Math.abs(days)} 天`,
      tone: "overdue",
      days,
    };
  }
  if (days === 0) return { label: "今天截止", tone: "today", days };
  return { label: `剩余 ${days} 天`, tone: days === 1 ? "soon" : "later", days };
}

export function isOverdue(key: string | null) {
  if (!key) return false;
  return differenceInCalendarDays(dateFromDayKey(key), startOfDay(new Date())) < 0;
}

export function isDueToday(key: string | null) {
  if (!key) return false;
  return differenceInCalendarDays(dateFromDayKey(key), startOfDay(new Date())) === 0;
}

export function stripMarkdown(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function excerpt(content: string, length = 120) {
  const text = stripMarkdown(content);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function noteTitle(title: string) {
  return title.trim() || "无标题笔记";
}

export function charCount(content: string) {
  return content.replace(/\s/g, "").length;
}

export function extractWikiLinks(content: string) {
  const matches = content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
  return Array.from(new Set(Array.from(matches, (m) => m[1].trim()))).filter(Boolean);
}

export function noteBacklinks(notes: { id: string; title: string; content: string }[], title: string) {
  if (!title.trim()) return [];
  return notes.filter((note) => note.title.trim() !== title.trim() && extractWikiLinks(note.content).includes(title.trim()));
}

export function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function timeGreetingLine() {
  return `${longDate()} · 今天`;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
