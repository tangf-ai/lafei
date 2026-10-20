import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, CheckCheck, ChevronDown, Flag, ListTodo, Plus, Sparkles } from "lucide-react";
import { db, createTask } from "../db";
import { useUI, toast } from "../store/ui";
import { cn, dayKey, dueLabel, isOverdue } from "../lib/util";
import { DUE_PRESETS, dayKeyOffset, duePresetDate, type DuePresetId } from "../lib/date";
import type { Priority, Task, TaskFilter } from "../types";
import { TaskRow } from "../components/TaskRow";

const FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "today", label: "今天" },
  { id: "upcoming", label: "接下来" },
  { id: "done", label: "已完成" },
];

const PRIORITY_OPTIONS: Array<{ id: Priority; label: string }> = [
  { id: "medium", label: "中优先" },
  { id: "high", label: "高优先" },
  { id: "low", label: "低优先" },
];

type GroupTone = "overdue" | "today" | "upcoming" | "later" | "done";

interface TaskGroup {
  key: string;
  label: string;
  tone: GroupTone;
  tasks: Task[];
}

export function TasksView() {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const filter = useUI((state) => state.taskFilter);
  const setFilter = useUI((state) => state.setTaskFilter);
  const setView = useUI((state) => state.setView);
  const [title, setTitle] = useState("");
  const [duePreset, setDuePreset] = useState<DuePresetId | "custom">("today");
  const [customDueDate, setCustomDueDate] = useState(dayKeyOffset(1));
  const [priority, setPriority] = useState<Priority>("medium");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const today = dayKey();
  const tomorrow = dayKeyOffset(1);
  const weekEnd = dayKeyOffset(7);
  const noteMap = new Map(notes.map((note) => [note.id, note]));
  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);

  const overdueTasks = open
    .filter((task) => isOverdue(task.dueDate))
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const dueTodayTasks = open.filter((task) => task.dueDate === today);
  const upcomingTasks = open
    .filter((task) => task.dueDate && task.dueDate > today)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const noDateTasks = open.filter((task) => !task.dueDate);
  const scheduledCount = open.filter((task) => Boolean(task.dueDate)).length;

  const counts: Record<TaskFilter, number> = {
    all: open.length,
    today: overdueTasks.length + dueTodayTasks.length,
    upcoming: upcomingTasks.length,
    done: done.length,
  };

  const sortedDone = useMemo(
    () => done.slice().sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)),
    [done],
  );

  const futureGroups = useMemo<TaskGroup[]>(() => {
    const byDate = new Map<string, Task[]>();
    for (const task of upcomingTasks) {
      if (!task.dueDate) continue;
      const group = byDate.get(task.dueDate) ?? [];
      group.push(task);
      byDate.set(task.dueDate, group);
    }
    return [...byDate.entries()].map(([date, groupTasks]) => {
      const label = dueLabel(date).label;
      const calendarDay = new Date(`${date}T12:00:00`);
      const dateText = `${calendarDay.getMonth() + 1}月${calendarDay.getDate()}日`;
      return {
        key: `date-${date}`,
        label: label === dateText ? label : `${label} · ${dateText}`,
        tone: date === tomorrow ? "today" : date <= weekEnd ? "upcoming" : "later",
        tasks: groupTasks,
      };
    });
  }, [tomorrow, upcomingTasks, weekEnd]);

  const groups = useMemo<TaskGroup[]>(() => {
    if (filter === "done") {
      return [{ key: "done", label: "已完成", tone: "done", tasks: sortedDone }];
    }
    if (filter === "today") {
      return [
        ...(overdueTasks.length
          ? [{ key: "overdue", label: "逾期", tone: "overdue" as const, tasks: overdueTasks }]
          : []),
        ...(dueTodayTasks.length
          ? [{ key: "today", label: "今天", tone: "today" as const, tasks: dueTodayTasks }]
          : []),
      ];
    }
    if (filter === "upcoming") {
      return futureGroups;
    }
    return [
      ...(overdueTasks.length
        ? [{ key: "overdue", label: "逾期", tone: "overdue" as const, tasks: overdueTasks }]
        : []),
      ...(dueTodayTasks.length
        ? [{ key: "today", label: "今天", tone: "today" as const, tasks: dueTodayTasks }]
        : []),
      ...futureGroups,
      ...(noDateTasks.length
        ? [{ key: "nodate", label: "无日期", tone: "later" as const, tasks: noDateTasks }]
        : []),
    ];
  }, [dueTodayTasks, filter, futureGroups, noDateTasks, overdueTasks, sortedDone]);

  const addTask = async () => {
    const value = title.trim();
    if (!value || adding) return;
    setAdding(true);
    const dueDate = duePreset === "custom" ? customDueDate || null : duePresetDate(duePreset);
    await createTask({ title: value, dueDate, priority });
    setTitle("");
    setAdding(false);
    const visibleInCurrentFilter =
      filter === "all" ||
      (filter === "today" && Boolean(dueDate) && dueDate! <= today) ||
      (filter === "upcoming" && Boolean(dueDate) && dueDate! > today);
    if (!visibleInCurrentFilter) setFilter("all");
    toast(dueDate ? `已添加到「${dueLabel(dueDate).label}」` : "已添加任务", "success");
    inputRef.current?.focus();
  };

  const isEmpty = groups.every((group) => group.tasks.length === 0);
  const summary =
    open.length === 0
      ? "清单是空的。写下下一件想推进的事，或者先休息一下。"
      : overdueTasks.length > 0
        ? `有 ${overdueTasks.length} 件已经逾期，今天 ${dueTodayTasks.length} 件，接下来 ${upcomingTasks.length} 件。先处理最近的一件。`
        : `今天 ${dueTodayTasks.length} 件，接下来 ${upcomingTasks.length} 件。任务按截止日期铺开，不必一次做完。`;

  return (
    <div className="view-scroll">
      <div className="page tasks-page">
        <header className="tasks-header">
          <div className="tasks-header-copy">
            <span className="eyebrow">Tasks</span>
            <h1 className="tasks-title display">把下一步写下来。</h1>
            <p className="tasks-subtitle">{summary}</p>
          </div>
          <div className="tasks-stats">
            <div className="task-stat">
              <strong>{counts.today}</strong>
              <span>今天</span>
            </div>
            <span className="task-stat-line" />
            <div className="task-stat">
              <strong>{upcomingTasks.length}</strong>
              <span>接下来</span>
            </div>
            <span className="task-stat-line" />
            <div className={cn("task-stat", overdueTasks.length > 0 && "is-alert")}>
              <strong>{overdueTasks.length}</strong>
              <span>逾期</span>
            </div>
          </div>
        </header>

        <form
          className="task-add-bar"
          onSubmit={(event) => {
            event.preventDefault();
            void addTask();
          }}
        >
          <div className="task-add-input">
            <Plus size={18} />
            <input
              ref={inputRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="记下一件要做的事…"
              aria-label="新任务标题"
            />
          </div>
          <div className="task-add-controls">
            <label className="task-add-select-wrap">
              <span className="sr-only">截止日期</span>
              <select
                className="task-add-select"
                value={duePreset}
                onChange={(event) => setDuePreset(event.target.value as DuePresetId | "custom")}
              >
                {DUE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.id === "none" ? "无日期" : preset.label}
                  </option>
                ))}
                <option value="custom">自定义…</option>
              </select>
              <ChevronDown size={12} />
            </label>
            {duePreset === "custom" && (
              <label className="task-add-date-wrap">
                <span className="sr-only">自定义截止日期</span>
                <input
                  type="date"
                  className="task-add-date"
                  value={customDueDate}
                  min={today}
                  onChange={(event) => setCustomDueDate(event.target.value)}
                />
              </label>
            )}
            <label className="task-add-select-wrap">
              <span className="sr-only">优先级</span>
              <Flag size={13} className={cn("priority-flag-icon", `priority-${priority}`)} />
              <select
                className="task-add-select"
                value={priority}
                onChange={(event) => setPriority(event.target.value as Priority)}
              >
                {PRIORITY_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
            <button type="submit" className="btn btn-primary task-add-submit" disabled={!title.trim() || adding}>
              <Plus size={15} /> 添加
            </button>
          </div>
        </form>

        <div className="tasks-toolbar">
          <div className="filter-tabs" role="tablist" aria-label="任务筛选">
            {FILTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                className={cn("filter-tab", filter === item.id && "active")}
                onClick={() => setFilter(item.id)}
              >
                {item.label}
                <span className="filter-tab-count">{counts[item.id]}</span>
              </button>
            ))}
          </div>
          <span className="tasks-toolbar-note">
            {filter === "done"
              ? "完成的每一小步都算数"
              : filter === "today"
                ? "逾期与今天 · 先处理最急的"
                : filter === "upcoming"
                  ? "按截止日期由近到远"
                  : `${open.length} 个未完成 · ${scheduledCount} 个有截止日期`}
          </span>
        </div>

        <div className="task-groups">
          {isEmpty ? (
            <div className="task-empty">
              <div className="task-empty-icon">
                {filter === "done" ? <CheckCheck size={22} /> : <ListTodo size={22} />}
              </div>
              <h3 className="display">
                {filter === "done"
                  ? "还没有完成的任务"
                  : filter === "today"
                    ? "今天，暂时没有安排"
                    : filter === "upcoming"
                      ? "接下来是空的"
                      : "所有事情都清空了"}
              </h3>
              <p>
                {filter === "done"
                  ? "完成一件小事后，它会出现在这里。"
                  : "给自己留一点空白，或者现在写下一件事。"}
              </p>
              {filter !== "done" && (
                <button type="button" className="btn btn-outline" onClick={() => inputRef.current?.focus()}>
                  <Plus size={14} /> 记一件事
                </button>
              )}
            </div>
          ) : (
            groups.map((group) =>
              group.tasks.length > 0 ? (
                <section className="task-group" key={group.key}>
                  <div className={cn("task-group-head", `tone-${group.tone}`)}>
                    <h2>{group.label}</h2>
                    <span>{group.tasks.length}</span>
                    <span className="task-group-line" />
                    {group.key === "overdue" && <span className="task-group-note">先处理这些</span>}
                    {group.key.startsWith("date-") && (
                      <span className="task-group-note">已安排</span>
                    )}
                    {group.key === "done" && group.tasks.length > 0 && (
                      <span className="task-group-note">
                        <Check size={12} /> 共 {group.tasks.length} 件
                      </span>
                    )}
                  </div>
                  <div className="task-group-list">
                    {group.tasks.map((task: Task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        note={task.noteId ? noteMap.get(task.noteId) : undefined}
                      />
                    ))}
                  </div>
                </section>
              ) : null,
            )
          )}
        </div>

        <div className="tasks-footer">
          <span>
            <Sparkles size={13} /> 不知道从哪开始？让 AI 帮你理一下。
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setView("assistant")}>
            打开 AI 助手
          </button>
        </div>
      </div>
    </div>
  );
}
