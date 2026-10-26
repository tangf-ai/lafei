import { useMemo } from "react";
import { addDays, format, startOfWeek } from "date-fns";
import { ArrowRight, Sparkles, Tag } from "lucide-react";
import type { Note, Task } from "../types";
import { useUI } from "../store/ui";
import { collectTagCounts } from "../lib/tags";
import { cn, dayKey, dueLabel } from "../lib/util";
import "./taskOverviewBand.css";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
/** 标签小圆点色板（与右栏 TasksRail 保持一致） */
const TAG_COLORS = ["#6E8B7A", "#B57B24", "#7A8290", "#A86B58", "#8A8F5C", "#4C7D86", "#8B6A9B"];
/** 到期汇总最多两行，每行最多五个圆点 */
const MAX_DUE_ROWS = 2;
const MAX_DUE_DOTS = 5;

function tagColor(tag: string) {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) hash = (hash * 31 + tag.charCodeAt(index)) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length];
}

interface TaskOverviewBandProps {
  tasks: Task[];
  notes: Note[];
  onShowDone: () => void;
  onOpenAssistant: () => void;
}

export function TaskOverviewBand({ tasks, notes, onShowDone, onOpenAssistant }: TaskOverviewBandProps) {
  const setView = useUI((state) => state.setView);
  const openTagView = useUI((state) => state.openTagView);

  // 进度口径：全部任务（含已完成）；「已排期 / 待安排」只统计未完成任务
  const openTasks = tasks.filter((task) => !task.done);
  const total = tasks.length;
  const doneCount = total - openTasks.length;
  const scheduledCount = openTasks.filter((task) => Boolean(task.dueDate)).length;
  const undatedCount = openTasks.length - scheduledCount;
  const progress = total === 0 ? 0 : Math.round((doneCount / total) * 100);

  // 未完成任务按截止日聚合，既用于日格小圆点，也用于底部到期汇总
  const dueByDate = new Map<string, number>();
  for (const task of openTasks) {
    if (!task.dueDate) continue;
    dueByDate.set(task.dueDate, (dueByDate.get(task.dueDate) ?? 0) + 1);
  }

  // 本周从周一开始，日格对应 7 天
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
      dueCount: dueByDate.get(key) ?? 0,
    };
  });

  // 到期汇总：把所有未完成且有截止日的日期按时间排序，取最近两行
  const dueRows = [...dueByDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, MAX_DUE_ROWS)
    .map(([key, count]) => ({ key, count, label: dueLabel(key).label }));

  const tagCounts = useMemo(() => collectTagCounts(notes, tasks).slice(0, 4), [notes, tasks]);

  // 分段环：每个任务一段，已完成深绿、已排期 45% 绿、待安排用 track 色
  const segmentCount = Math.max(total, 1);
  const segmentAngle = 100 / segmentCount;
  const segmentDash = Math.max(segmentAngle - 2.2, 1);
  const ringSegments = tasks.map((task, index) => ({
    key: task.id,
    tone: task.done ? "is-done" : task.dueDate ? "is-scheduled" : "is-todo",
    dashArray: `${segmentDash} ${100 - segmentDash}`,
    dashOffset: `${-(index * segmentAngle)}`,
  }));

  return (
    <section className="wb-band" aria-label="任务概览">
      <section className="wb-band-card" aria-label="本周节奏">
        <div className="wb-band-head">
          <h3 className="wb-band-title">本周节奏</h3>
          <span className="wb-band-meta">
            {format(weekStart, "M/d")} – {format(addDays(weekStart, 6), "M/d")}
          </span>
        </div>
        <div className="wb-band-week">
          {weekDays.map((day) => (
            <div
              key={day.key}
              className={cn("wb-band-day", day.isToday && "is-today", day.dueCount > 0 && "is-due")}
              title={day.dueCount > 0 ? `${day.dueCount} 件到期` : undefined}
            >
              <span className="wb-band-day-label">{day.label}</span>
              <span className="wb-band-day-num">{day.day}</span>
            </div>
          ))}
        </div>
        {dueRows.length > 0 && (
          <div className="wb-band-due">
            {dueRows.map((row) => (
              <div className="wb-band-due-row" key={row.key}>
                <span className="wb-band-due-label">{row.label}</span>
                <span className="wb-band-due-dots" aria-hidden="true">
                  {Array.from({ length: Math.min(row.count, MAX_DUE_DOTS) }, (_, index) => (
                    <i key={index} />
                  ))}
                </span>
                <span className="wb-band-due-count">{row.count}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="wb-band-card" aria-label="进度">
        <div className="wb-band-head">
          <h3 className="wb-band-title">进度</h3>
          <span className="wb-band-meta">今天</span>
        </div>
        <div className="wb-band-prog">
          <div className="wb-band-ring">
            <svg className="wb-band-ring-svg" viewBox="0 0 104 104" aria-hidden="true">
              <circle
                className="wb-band-ring-base"
                cx="52"
                cy="52"
                r="43"
                pathLength={100}
                strokeDasharray="100 0"
              />
              {ringSegments.map((segment) => (
                <circle
                  key={segment.key}
                  className={cn("wb-band-ring-seg", segment.tone)}
                  cx="52"
                  cy="52"
                  r="43"
                  pathLength={100}
                  strokeDasharray={segment.dashArray}
                  strokeDashoffset={segment.dashOffset}
                />
              ))}
            </svg>
            <div className="wb-band-ring-center">
              <div className="wb-band-ring-num">
                {doneCount}
                <small>/ {total}</small>
              </div>
              <div className="wb-band-ring-cap">已完成 {progress}%</div>
            </div>
          </div>
          <div className="wb-band-prog-side">
            <div className="wb-band-side-title">
              本周 {total} 件，完成 {doneCount} 件
            </div>
            <div className="wb-band-bar">
              <i style={{ width: `${progress}%` }} />
            </div>
            <div className="wb-band-side-note">
              {scheduledCount} 件已排期 · {undatedCount} 件待安排
            </div>
            <button type="button" className="wb-band-link" onClick={onShowDone}>
              查看已完成
              <ArrowRight size={9} />
            </button>
          </div>
        </div>
      </section>

      <section className="wb-band-card" aria-label="标签">
        <div className="wb-band-head">
          <h3 className="wb-band-title">标签</h3>
          <button type="button" className="wb-band-link" onClick={() => setView("tags")}>
            全部
            <ArrowRight size={9} />
          </button>
        </div>
        <div className="wb-band-tag-body">
          {tagCounts.length > 0 ? (
            <div className="wb-band-tag-chips">
              {tagCounts.map((tag) => (
                <button
                  key={tag.tag}
                  type="button"
                  className="wb-band-chip"
                  title={`#${tag.tag} · ${tag.total} 条`}
                  onClick={() => openTagView(tag.tag)}
                >
                  <i style={{ background: tagColor(tag.tag) }} />
                  <span>#{tag.tag}</span>
                  <b>{tag.total}</b>
                </button>
              ))}
            </div>
          ) : (
            <p className="wb-band-tag-empty">还没有标签</p>
          )}
          <div className="wb-band-tag-note">
            <Tag size={9} />
            标签同时连接笔记与任务
          </div>
        </div>
      </section>

      <section className="wb-band-card wb-band-ai" aria-label="AI 分诊">
        <div className="wb-band-ai-top">
          <span className="wb-band-ai-icon">
            <Sparkles size={12} />
          </span>
          <h3 className="wb-band-ai-title">让 AI 帮我分诊</h3>
        </div>
        <p className="wb-band-ai-copy">
          {openTasks.length > 0 ? (
            <>
              把这 <b>{openTasks.length} 件事</b>按「重要 × 紧急」过一遍，先给你一个建议顺序。
            </>
          ) : (
            <>当前没有待分诊的任务，可以让我按「重要 × 紧急」再核对一遍。</>
          )}
        </p>
        <div className="wb-band-ai-foot">
          <button type="button" className="wb-band-ai-btn" onClick={onOpenAssistant}>
            开始分诊
            <ArrowRight size={9} />
          </button>
          <span className="wb-band-ai-note">随时可以自己拖</span>
        </div>
      </section>
    </section>
  );
}
