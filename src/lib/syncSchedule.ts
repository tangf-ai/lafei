/**
 * 数据仓库的定时同步间隔。
 * 设置项本身保存在 useUI（localStorage），这里只放常量与格式化，
 * 让设置 UI 和同步引擎共用同一份选项，避免两边各写一套。
 */

export interface SyncIntervalOption {
  /** 间隔分钟数，0 表示关闭 */
  minutes: number;
  label: string;
}

export const SYNC_INTERVAL_OPTIONS: SyncIntervalOption[] = [
  { minutes: 0, label: "关闭" },
  { minutes: 5, label: "5 分钟" },
  { minutes: 15, label: "15 分钟" },
  { minutes: 30, label: "30 分钟" },
  { minutes: 60, label: "1 小时" },
  { minutes: 180, label: "3 小时" },
];

/** 默认每 30 分钟与文件夹完整合并一次 */
export const SYNC_INTERVAL_DEFAULT = 30;

export function syncIntervalLabel(minutes: number) {
  if (minutes <= 0) return "关闭";
  const preset = SYNC_INTERVAL_OPTIONS.find((option) => option.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

/**
 * 把持久化里可能被手改成奇怪值的间隔收敛到预设档位：
 * 非法值回落到默认值，非预设的分钟数就近取整（0 仍表示关闭），
 * 保证设置页永远有一个选中项，也不会出现 1 分钟一次的全量同步。
 */
export function normalizeSyncInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SYNC_INTERVAL_DEFAULT;
  const minutes = Math.round(value);
  if (minutes <= 0) return 0;
  if (SYNC_INTERVAL_OPTIONS.some((option) => option.minutes === minutes)) return minutes;

  let closest = SYNC_INTERVAL_DEFAULT;
  let smallestDistance = Number.POSITIVE_INFINITY;
  for (const option of SYNC_INTERVAL_OPTIONS) {
    if (option.minutes <= 0) continue;
    const distance = Math.abs(option.minutes - minutes);
    if (distance < smallestDistance) {
      smallestDistance = distance;
      closest = option.minutes;
    }
  }
  return closest;
}
