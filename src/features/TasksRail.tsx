import { addDays, format, startOfWeek } from "date-fns";
import { Sparkles } from "lucide-react";
import type { Note, Task } from "../types";
import { useUI } from "../store/ui";
import { collectTagCounts } from "../lib/tags";
import { cn, dayKey, dueLabel } from "../lib/util";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const TAG_COLORS = ["#6E8B7A", "#B57B24", "#7A8290", "#A86B58", "#8A8F5C", "#4C7D86", "#8B6A9B"];

function tagColor(tag: string) {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) hash = (hash * 31 + tag.charCodeAt(index)) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length];
}

export function TasksRail({ tasks, notes }: { tasks: Task[]; notes: Note[] }) {
  const setView = useUI((state) => state.setView);
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);

  const openTasks = tasks.filter((task) => !task.done);
  const doneTasks = tasks.filter((task) => task.done);
  const scheduled = openTasks.filter((task) => Boolean(task.dueDate));
  const undated = openTasks.filter((task) => !task.dueDate);
  const total = tasks.length;
  const progress = total === 0 ? 0 : Math.round((doneTasks.length / total) * 100);

  const today = dayKey();
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    const key = dayKey(date);
    return {
      key,
      label: WEEKDAYS[index],
      day: format(date, "d"),
      isToday: key === today,
      dueCount: openTasks.filter((task) => task.dueDate === key).length,
    };
  });

  const dueByDate = new Map<string, number>();
  for (const task of scheduled) {
    if (!task.dueDate) continue;
    dueByDate.set(task.dueDate, (dueByDate.get(task.dueDate) ?? 0) + 1);
  }
  const upcomingDues = [...dueByDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 2)
    .map(([key, count]) => ({ key, count, label: dueLabel(key).label }));

  const tagCounts = collectTagCounts(notes, tasks).slice(0, 5);
  const backlog = undated.slice(0, 4);

  // 环形进度：已完成 / 已排期 / 待安排，三种颜色按任务状态分段
  const segmentCount = Math.max(total, 1);
  const segmentAngle = 100 / segmentCount;
  const segmentDash = Math.max(segmentAngle - 2.2, 1);
  const ringSegments = tasks.map((task, index) => {
    const color = task.done
      ? "var(--wb-green)"
      : task.dueDate
        ? "color-mix(in srgb, var(--wb-green) 45%, var(--wb-card))"
        : "var(--wb-ring-track)";
    return {
      key: task.id,
      color,
      dashArray: `${segmentDash} ${100 - segmentDash}`,
      dashOffset: `${-(index * segmentAngle)}`,
    };
  });

  return (
    <aside className="wb-rail" aria-label="任务概览">
      <section className="wb-card">
        <div className="wb-card-head">
          <span className="wb-card-title">本周节奏</span>
          <span className="wb-card-meta">
            {format(weekStart, "M/d")} – {format(addDays(weekStart, 6), "M/d")}
          </span>
        </div>
        <div className="wb-week-grid">
          {weekDays.map((day) => (
            <div
              key={day.key}
              className={cn("wb-day", day.isToday && "today", !day.isToday && day.dueCount > 0 && "due")}
              title={day.dueCount > 0 ? `${day.dueCount} 件到期` : undefined}
            >
              <span>{day.label}</span>
              <span>{day.day}</span>
            </div>
          ))}
        </div>
        {upcomingDues.length > 0 && (
          <div className="wb-week-due">
            {upcomingDues.map((due) => (
              <div className="wb-due-row" key={due.key}>
                <span className="wb-due-date">{due.label}</span>
                <span className="wb-due-dots">
                  {Array.from({ length: Math.min(due.count, 3) }, (_, index) => (
                    <i key={index} />
                  ))}
                </span>
                <span className="wb-due-count">{due.count}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="wb-card">
        <div className="wb-card-head">
          <span className="wb-card-title">进度</span>
          <span className="wb-card-meta">今天</span>
        </div>
        <div className="wb-ring-wrap">
          <svg className="wb-ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle
              cx="60"
              cy="60"
              r="48"
              pathLength="100"
              stroke="var(--wb-ring-track)"
              strokeDasharray="100 0"
              opacity="0.55"
            />
            {ringSegments.map((segment) => (
              <circle
                key={segment.key}
                cx="60"
                cy="60"
                r="48"
                pathLength="100"
                stroke={segment.color}
                strokeDasharray={segment.dashArray}
                strokeDashoffset={segment.dashOffset}
              />
            ))}
          </svg>
          <div className="wb-ring-center">
            <div className="wb-ring-num">
              {doneTasks.length}
              <span>/ {total}</span>
            </div>
            <div className="wb-ring-label">已完成 · {progress}%</div>
          </div>
        </div>
        <p className="wb-progress-note">
          <i />
          {scheduled.length} 件已排期
          <span className="sep">·</span>
          <i className="is-pale" />
          {undated.length} 件待安排
        </p>
      </section>

      {tagCounts.length > 0 && (
        <section className="wb-card">
          <div className="wb-card-head">
            <span className="wb-card-title">标签</span>
            <span className="wb-card-meta">{collectTagCounts(notes, tasks).length}</span>
          </div>
          <div className="wb-tag-chips">
            {tagCounts.map((tag) => (
              <span className="wb-tag-chip" key={tag.tag}>
                <i style={{ background: tagColor(tag.tag) }} />#{tag.tag}
                <b>{tag.total}</b>
              </span>
            ))}
          </div>
        </section>
      )}

      {backlog.length > 0 && (
        <section className="wb-card">
          <div className="wb-card-head">
            <span className="wb-card-title">待安排</span>
            <span className="wb-backlog-count">{undated.length}</span>
          </div>
          <div className="wb-backlog-list">
            {backlog.map((task) => (
              <button
                key={task.id}
                type="button"
                className="wb-backlog-row"
                onClick={() => setTaskDetailId(task.id)}
              >
                <span className="wb-backlog-check" />
                <span className="wb-backlog-title">{task.title || "未命名任务"}</span>
                <span className={cn("wb-backlog-dot", task.priority === "high" && "is-high")} />
              </button>
            ))}
          </div>
        </section>
      )}

      <button type="button" className="wb-ai-card" onClick={() => setView("assistant")}>
        <span className="wb-ai-icon">
          <Sparkles size={15} />
        </span>
        <span className="wb-ai-body">
          <span className="wb-ai-title">让 AI 帮我排期</span>
          <span className="wb-ai-sub">
            打开 AI 助手
            <svg
              viewBox="0 0 24 24"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 12h15m-5.5-5.5 5.5 5.5-5.5 5.5" />
            </svg>
          </span>
        </span>
      </button>
    </aside>
  );
}
