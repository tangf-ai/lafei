import { cn } from "../lib/util";

interface RemainingBadgeProps {
  /** 距截止日还有几天（只传给「剩余 N 天」用，逾期 / 今天由截止标签表达） */
  days: number;
  tone: "overdue" | "today" | "soon" | "later" | "none";
  /** 紧凑一档：象限行、今日「接下来」这类窄处 */
  compact?: boolean;
  className?: string;
}

/**
 * 任务剩余时间倒计时：数字放大加粗，≤3 天走金色底，「还早」走中性底。
 * 列表行 / 分组头 / 四象限 / 今日「接下来」共用同一套观感。
 */
export function RemainingBadge({ days, tone, compact = false, className }: RemainingBadgeProps) {
  return (
    <span className={cn("task-remaining", `tone-${tone}`, compact && "is-compact", className)}>
      <span className="task-remaining-label">剩余</span>
      <span className="task-remaining-num">{days}</span>
      <span className="task-remaining-label">天</span>
    </span>
  );
}
