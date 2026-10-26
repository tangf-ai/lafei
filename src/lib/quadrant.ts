import { differenceInCalendarDays, startOfDay } from "date-fns";
import type { Quadrant, Task } from "../types";
import { dateFromDayKey } from "./util";

export interface QuadrantMeta {
  id: Quadrant;
  /** 象限编号，跟随 Eisenhower 顺序：01 = 重要紧急 */
  num: string;
  title: string;
  hint: string;
  /** 象限空着时的一句话 */
  empty: string;
}

/** 四象限的固定顺序：01 重要紧急 / 02 重要不紧急 / 03 紧急不重要 / 04 不重要不紧急 */
export const QUADRANTS: QuadrantMeta[] = [
  { id: "q1", num: "01", title: "重要 · 紧急", hint: "马上做", empty: "现在没有必须马上做的事" },
  { id: "q2", num: "02", title: "重要 · 不紧急", hint: "安排时间", empty: "长期重要的事，记得给它留时间" },
  { id: "q3", num: "03", title: "紧急 · 不重要", hint: "快速处理", empty: "没有被打断的事，挺好" },
  { id: "q4", num: "04", title: "不重要 · 不紧急", hint: "稍后再说", empty: "空着最好" },
];

export const QUADRANT_ORDER: Quadrant[] = ["q1", "q2", "q3", "q4"];

/** 自动落位时「紧急」的窗口：已经逾期，或 7 天内到期 */
export const URGENT_WINDOW_DAYS = 7;

/**
 * 没有手动归过象限时的默认落位：
 * 紧急 = 已逾期或 7 天内到期；重要 = 优先级不是「低」。
 * 只是第一眼的建议，拖一下就改成手工判断。
 */
export function autoQuadrant(task: Pick<Task, "dueDate" | "priority">): Quadrant {
  const urgent = task.dueDate
    ? differenceInCalendarDays(dateFromDayKey(task.dueDate), startOfDay(new Date())) <= URGENT_WINDOW_DAYS
    : false;
  const important = task.priority !== "low";
  if (important) return urgent ? "q1" : "q2";
  return urgent ? "q3" : "q4";
}

export function quadrantOf(task: Pick<Task, "quadrant" | "dueDate" | "priority">): Quadrant {
  return task.quadrant ?? autoQuadrant(task);
}

export function quadrantMeta(id: Quadrant): QuadrantMeta {
  return QUADRANTS.find((item) => item.id === id) ?? QUADRANTS[0];
}

const PRIORITY_WEIGHT: Record<Task["priority"], number> = { high: 0, medium: 1, low: 2 };

/** 象限内排序：截止早的在前，同一天按优先级，再按最近更新 */
export function sortQuadrantTasks(a: Task, b: Task) {
  const aDue = a.dueDate ?? "9999-12-31";
  const bDue = b.dueDate ?? "9999-12-31";
  if (aDue !== bDue) return aDue.localeCompare(bDue);
  return PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority] || b.updatedAt - a.updatedAt;
}

export function groupTasksByQuadrant(tasks: Task[]): Record<Quadrant, Task[]> {
  const groups: Record<Quadrant, Task[]> = { q1: [], q2: [], q3: [], q4: [] };
  for (const task of tasks) groups[quadrantOf(task)].push(task);
  for (const id of QUADRANT_ORDER) groups[id].sort(sortQuadrantTasks);
  return groups;
}
