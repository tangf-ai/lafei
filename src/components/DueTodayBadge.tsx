import { cn } from "../lib/util";

interface DueTodayBadgeProps {
  /** 紧凑一档：四象限行、分组头这类窄处 */
  compact?: boolean;
  className?: string;
}

/**
 * 「今天截止」徽标：截止日就是今天的任务在列表行 / 分组头 / 四象限 / 今日页共用。
 * 和「剩余 N 天」同一套尺寸节奏，用红调把「今天到期」从普通日期里拎出来；
 * 逾期 / 明天及更远的日期仍走原来的文字标签。
 */
export function DueTodayBadge({ compact = false, className }: DueTodayBadgeProps) {
  return (
    <span
      className={cn("task-due-today", compact && "is-compact", className)}
      title="截止日期是今天"
    >
      <span className="task-due-today-main">今天</span>
      <span className="task-due-today-suffix">截止</span>
    </span>
  );
}
