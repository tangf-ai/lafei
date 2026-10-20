import { addDays } from "date-fns";
import { dayKey } from "./util";

export function dayKeyOffset(days: number) {
  return dayKey(addDays(new Date(), days));
}

export const DUE_PRESETS = [
  { id: "today", label: "今天", days: 0 },
  { id: "tomorrow", label: "明天", days: 1 },
  { id: "three", label: "三天后", days: 3 },
  { id: "none", label: "无日期", days: null },
] as const;

export type DuePresetId = (typeof DUE_PRESETS)[number]["id"];

export function duePresetDate(id: DuePresetId): string | null {
  const preset = DUE_PRESETS.find((item) => item.id === id);
  if (!preset || preset.days === null) return null;
  return dayKeyOffset(preset.days);
}
