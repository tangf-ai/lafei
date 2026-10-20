import { useEffect, useState } from "react";
import { endOfDay } from "date-fns";
import { ArrowUpRight, CalendarClock, TimerReset } from "lucide-react";
import type { Task } from "../types";
import { useUI } from "../store/ui";
import { cn, dateFromDayKey, dayKey, dueLabel } from "../lib/util";

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

function chooseTarget(tasks: Task[]) {
  const dated = tasks.filter((task) => !task.done && task.dueDate);
  if (!dated.length) return null;
  const today = dayKey();
  const overdue = dated
    .filter((task) => task.dueDate! < today)
    .sort(
      (a, b) =>
        b.dueDate!.localeCompare(a.dueDate!) ||
        PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority],
    );
  if (overdue.length) return overdue[0];
  return dated.sort(
    (a, b) =>
      a.dueDate!.localeCompare(b.dueDate!) ||
      PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority],
  )[0];
}

function parts(distance: number) {
  const totalSeconds = Math.max(0, Math.floor(distance / 1000));
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
  };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function DeadlineCountdown({ tasks }: { tasks: Task[] }) {
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const target = chooseTarget(tasks);

  if (!target) {
    return (
      <div className="deadline-countdown is-empty">
        <span className="deadline-icon">
          <CalendarClock size={18} />
        </span>
        <span className="deadline-empty-copy">
          <strong>还没有倒计时</strong>
          <em>给任务设置截止日期后，这里会显示距离截止的实时时间。</em>
        </span>
      </div>
    );
  }

  const deadline = endOfDay(dateFromDayKey(target.dueDate!)).getTime();
  const overdue = deadline < now;
  const time = parts(Math.abs(deadline - now));
  const due = dueLabel(target.dueDate!);
  const dateText = new Date(`${target.dueDate}T12:00:00`).toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
  const countdownLabel = overdue
    ? `已逾期 ${time.days} 天 ${time.hours} 小时 ${time.minutes} 分`
    : `剩余 ${time.days} 天 ${time.hours} 小时 ${time.minutes} 分`;

  return (
    <button
      type="button"
      className={cn("deadline-countdown", overdue && "is-overdue")}
      onClick={() => setTaskDetailId(target.id)}
      title={`打开任务：${target.title || "未命名任务"}`}
    >
      <span className="deadline-icon">
        <TimerReset size={19} />
      </span>

      <span className="deadline-copy">
        <span className="deadline-kicker">
          <span className={cn("deadline-dot", `priority-${target.priority}`)} />
          {overdue ? "已逾期" : "下一个截止"}
          <span className="deadline-due-pill">{due.label}</span>
        </span>
        <strong>{target.title || "未命名任务"}</strong>
        <span className="deadline-meta">
          {dateText}
          {target.priority === "high" ? " · 高优先级" : ""}
        </span>
      </span>

      <span className="deadline-clock" aria-label={countdownLabel}>
        <span className="deadline-unit">
          <b>{pad(time.days)}</b>
          <em>天</em>
        </span>
        <span className="deadline-unit">
          <b>{pad(time.hours)}</b>
          <em>时</em>
        </span>
        <span className="deadline-unit">
          <b>{pad(time.minutes)}</b>
          <em>分</em>
        </span>
        <span className="deadline-unit is-seconds">
          <b>{pad(time.seconds)}</b>
          <em>秒</em>
        </span>
      </span>

      <span className="deadline-open" aria-hidden="true">
        <ArrowUpRight size={15} />
      </span>
    </button>
  );
}
