import { useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, CheckCheck, ChevronDown, Flag, ListTodo, Plus, Sparkles } from "lucide-react";
import { db, createTask } from "../db";
import { useUI, toast } from "../store/ui";
import { cn, dayKey, isOverdue } from "../lib/util";
import { DUE_PRESETS, duePresetDate, type DuePresetId } from "../lib/date";
import type { Priority, Task } from "../types";
import { TaskRow } from "../components/TaskRow";

type TaskFilter = "today" | "upcoming" | "all" | "done";

const FILTERS: Array<{ id: TaskFilter; label: string }> = [
  { id: "today", label: "今天" },
  { id: "upcoming", label: "接下来" },
  { id: "all", label: "待办" },
  { id: "done", label: "已完成" },
];

const PRIORITY_OPTIONS: Array<{ id: Priority; label: string }> = [
  { id: "medium", label: "中优先" },
  { id: "high", label: "高优先" },
  { id: "low", label: "低优先" },
];

export function TasksView() {
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const [filter, setFilter] = useState<TaskFilter>("today");
  const [title, setTitle] = useState("");
  const [duePreset, setDuePreset] = useState<DuePresetId>("today");
  const [priority, setPriority] = useState<Priority>("medium");
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const today = dayKey();
  const noteMap = new Map(notes.map((note) => [note.id, note]));
  const open = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);
  const todayTasks = open.filter((task) => task.dueDate === today || isOverdue(task.dueDate));
  const upcomingTasks = open
    .filter((task) => task.dueDate && task.dueDate > today)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const doneThisWeek = done.filter(
    (task) => task.completedAt && task.completedAt > Date.now() - 7 * 24 * 60 * 60 * 1000,
  );

  const counts: Record<TaskFilter, number> = {
    today: todayTasks.length,
    upcoming: upcomingTasks.length,
    all: open.length,
    done: done.length,
  };

  const sortedDone = useMemo(
    () => done.slice().sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)),
    [done],
  );

  const groups = useMemo(() => {
    if (filter === "done") {
      return [{ key: "done", label: "已完成", tone: "done", tasks: sortedDone }];
    }
    if (filter === "today") {
      const overdue = open
        .filter((task) => isOverdue(task.dueDate))
        .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
      const dueToday = open.filter((task) => task.dueDate === today);
      return [
        ...(overdue.length ? [{ key: "overdue", label: "逾期", tone: "overdue", tasks: overdue }] : []),
        { key: "today", label: "今天", tone: "today", tasks: dueToday },
      ];
    }
    if (filter === "upcoming") {
      return [{ key: "upcoming", label: "接下来", tone: "upcoming", tasks: upcomingTasks }];
    }
    const overdue = open.filter((task) => isOverdue(task.dueDate));
    const dueToday = open.filter((task) => task.dueDate === today);
    const future = upcomingTasks;
    const noDate = open.filter((task) => !task.dueDate);
    return [
      ...(overdue.length ? [{ key: "overdue", label: "逾期", tone: "overdue", tasks: overdue }] : []),
      ...(dueToday.length ? [{ key: "today", label: "今天", tone: "today", tasks: dueToday }] : []),
      ...(future.length ? [{ key: "upcoming", label: "接下来", tone: "upcoming", tasks: future }] : []),
      ...(noDate.length ? [{ key: "nodate", label: "无日期", tone: "later", tasks: noDate }] : []),
    ];
  }, [filter, open, sortedDone, today, upcomingTasks]);

  const addTask = async () => {
    const value = title.trim();
    if (!value || adding) return;
    setAdding(true);
    const dueDate = duePresetDate(duePreset);
    await createTask({ title: value, dueDate, priority });
    setTitle("");
    setAdding(false);
    toast("已添加任务", "success");
    inputRef.current?.focus();
  };

  const isEmpty = groups.every((group) => group.tasks.length === 0);

  return (
    <div className="view-scroll">
      <div className="page tasks-page">
        <header className="tasks-header">
          <div className="tasks-header-copy">
            <span className="eyebrow">Tasks</span>
            <h1 className="tasks-title display">把下一步写下来。</h1>
            <p className="tasks-subtitle">
              不用装下所有事，只需要知道下一件。今天有 {counts.today} 件待办
              {counts.today > 0 ? "，从最小的一步开始。" : "。"}
            </p>
          </div>
          <div className="tasks-stats">
            <div className="task-stat">
              <strong>{counts.today}</strong>
              <span>今天</span>
            </div>
            <span className="task-stat-line" />
            <div className={cn("task-stat", open.some((task) => isOverdue(task.dueDate)) && "is-alert")}>
              <strong>{open.filter((task) => isOverdue(task.dueDate)).length}</strong>
              <span>逾期</span>
            </div>
            <span className="task-stat-line" />
            <div className="task-stat">
              <strong>{doneThisWeek.length}</strong>
              <span>近 7 天完成</span>
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
                onChange={(event) => setDuePreset(event.target.value as DuePresetId)}
              >
                {DUE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.id === "none" ? "无日期" : preset.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </label>
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
            {filter === "done" ? "完成的每一小步都算数" : `${open.length} 个待办未完成`}
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
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => useUI.getState().setView("assistant")}>
            打开 AI 助手
          </button>
        </div>
      </div>
    </div>
  );
}
