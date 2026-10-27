import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  CheckCheck,
  ChevronDown,
  Flag,
  ListTodo,
  Plus,
  Sparkles,
  Tag,
} from "lucide-react";
import { db, createTask } from "../db";
import { useUI, toast } from "../store/ui";
import { cn, dayGroupLabel, dayKey, dueLabel, isOverdue, remainingLabel } from "../lib/util";
import { collectTagCounts, hasTag } from "../lib/tags";
import { DUE_PRESETS, dayKeyOffset, duePresetDate, type DuePresetId } from "../lib/date";
import type { Priority, Quadrant, Task, TaskFilter } from "../types";
import { TaskRow } from "../components/TaskRow";
import { TaskCalendar } from "../features/TaskCalendar";
import { TasksRail } from "../features/TasksRail";
import { TagInput } from "../components/TagInput";
import { TaskMatrix } from "../features/TaskMatrix";
import { TaskOverviewBand } from "../features/TaskOverviewBand";
import { quadrantMeta } from "../lib/quadrant";

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
  const allTasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const filter = useUI((state) => state.taskFilter);
  const setFilter = useUI((state) => state.setTaskFilter);
  const setView = useUI((state) => state.setView);
  const tagFilter = useUI((state) => state.tagFilter);
  const setTagFilter = useUI((state) => state.setTagFilter);
  const setAssistantDraft = useUI((state) => state.setAssistantDraft);
  const openTagView = useUI((state) => state.openTagView);
  const viewMode = useUI((state) => state.taskView);
  const setViewMode = useUI((state) => state.setTaskView);
  const [title, setTitle] = useState("");
  const [duePreset, setDuePreset] = useState<DuePresetId | "custom">("today");
  const [customDueDate, setCustomDueDate] = useState(dayKeyOffset(1));
  const [priority, setPriority] = useState<Priority>("medium");
  const [newTags, setNewTags] = useState<string[]>([]);
  const [tagRowOpen, setTagRowOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newQuadrant, setNewQuadrant] = useState<Quadrant | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const tasks = useMemo(
    () => (tagFilter ? allTasks.filter((task) => hasTag(task, tagFilter)) : allTasks),
    [allTasks, tagFilter],
  );
  const tagSuggestions = useMemo(
    () => collectTagCounts(notes, allTasks).map((item) => item.tag),
    [allTasks, notes],
  );

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
  const upcomingCount = upcomingTasks.length + noDateTasks.length;

  const counts: Record<TaskFilter, number> = {
    all: open.length,
    today: dueTodayTasks.length,
    upcoming: upcomingCount,
    done: done.length,
  };

  const sortedDone = useMemo(
    () => done.slice().sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)),
    [done],
  );

  // 已完成：按完成日期分组（没有完成时间的老数据退回更新时间）
  const doneGroups = useMemo<TaskGroup[]>(() => {
    const buckets = new Map<string, Task[]>();
    for (const task of sortedDone) {
      const stamp = task.completedAt ?? task.updatedAt ?? task.createdAt;
      const key = dayKey(new Date(stamp));
      const bucket = buckets.get(key);
      if (bucket) bucket.push(task);
      else buckets.set(key, [task]);
    }
    return [...buckets.entries()].map(([key, groupTasks]) => ({
      key: `done-${key}`,
      label: dayGroupLabel(key),
      tone: "done" as const,
      tasks: groupTasks,
    }));
  }, [sortedDone]);

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
      return doneGroups;
    }
    if (filter === "today") {
      return dueTodayTasks.length
        ? [{ key: "today", label: "今天", tone: "today" as const, tasks: dueTodayTasks }]
        : [];
    }
    if (filter === "upcoming") {
      return [
        ...futureGroups,
        ...(noDateTasks.length
          ? [{ key: "nodate", label: "待安排", tone: "later" as const, tasks: noDateTasks }]
          : []),
      ];
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
        ? [{ key: "nodate", label: "待安排", tone: "later" as const, tasks: noDateTasks }]
        : []),
    ];
  }, [doneGroups, dueTodayTasks, filter, futureGroups, noDateTasks, overdueTasks]);

  useEffect(() => {
    // 「已完成」是列表的概念：矩阵里只看没做完的事
    if (filter === "done" && viewMode === "matrix") setViewMode("list");
  }, [filter, viewMode]);

  const showDone = () => {
    setFilter("done");
    setViewMode("list");
  };

  const focusComposer = () => window.requestAnimationFrame(() => inputRef.current?.focus());

  const closeQuickEntry = () => {
    setQuickOpen(false);
    setNewQuadrant(null);
  };

  // 矩阵模式的「＋ 新建任务」：打开浮层快捷新建（不带象限）
  const openQuickEntry = () => {
    setNewQuadrant(null);
    setViewMode("matrix");
    setQuickOpen(true);
    focusComposer();
  };

  const addTaskToQuadrant = (quadrant: Quadrant) => {
    setNewQuadrant(quadrant);
    setViewMode("matrix");
    setQuickOpen(true);
    focusComposer();
  };

  // 浮层快捷新建：Esc / 点外面收起
  useEffect(() => {
    if (!quickOpen || viewMode !== "matrix") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setQuickOpen(false);
        setNewQuadrant(null);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".task-quick-layer") || target.closest(".wb-matrix-new")) return;
      setQuickOpen(false);
      setNewQuadrant(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [quickOpen, viewMode]);

  const addTask = async () => {
    const value = title.trim();
    if (!value || adding) return;
    setAdding(true);
    const dueDate = duePreset === "custom" ? customDueDate || null : duePresetDate(duePreset);
    // 正在按标签筛选时，新任务默认沿用这个标签，否则刚添加就会从当前列表消失
    const tags = newTags.length ? newTags : tagFilter ? [tagFilter] : [];
    const quadrant = newQuadrant;
    await createTask({ title: value, dueDate, priority, tags, quadrant });
    setTitle("");
    setNewTags([]);
    setTagRowOpen(false);
    setAdding(false);
    setNewQuadrant(null);
    if (viewMode === "matrix") setQuickOpen(false);
    const visibleInCurrentFilter =
      viewMode !== "list" ||
      filter === "all" ||
      (filter === "today" && Boolean(dueDate) && dueDate! <= today) ||
      (filter === "upcoming" && Boolean(dueDate) && dueDate! > today);
    if (!visibleInCurrentFilter) setFilter("all");
    toast(
      quadrant
        ? `已加入「${quadrantMeta(quadrant).title}」${tags.length ? ` · #${tags[0]}` : ""}`
        : dueDate
          ? `已添加到「${dueLabel(dueDate).label}」${tags.length ? ` · #${tags[0]}` : ""}`
          : tags.length
            ? `已添加任务 · #${tags[0]}`
            : "已添加任务",
      "success",
    );
    if (viewMode !== "matrix") inputRef.current?.focus();
  };

  const isEmpty = groups.every((group) => group.tasks.length === 0);
  const summary =
    open.length === 0
      ? "清单是空的。写下下一件想推进的事，或者先休息一下。"
      : overdueTasks.length > 0
        ? `有 ${overdueTasks.length} 件已经逾期，今天 ${dueTodayTasks.length} 件，接下来 ${upcomingCount} 件${noDateTasks.length ? `（${noDateTasks.length} 件待安排）` : ""}。先处理最近的一件。`
        : `今天 ${dueTodayTasks.length} 件，接下来 ${upcomingCount} 件${noDateTasks.length ? `（${noDateTasks.length} 件待安排）` : ""}。任务按截止日期铺开，不必一次做完。`;

  return (
    <div className={cn("view-scroll", viewMode === "matrix" && "is-matrix")}>
      <div className={cn("wb-tasks", viewMode === "matrix" && "is-matrix")} data-tauri-drag-region>
        <div className="wb-tasks-main">
        {/* 矩阵模式：标题区整块收掉 —— 输入条已经把「新建任务」这件事做了，
            矩阵板头就是页面的标题，省下来的高度留给象限 */}
        {viewMode !== "matrix" && (
          <header className="wb-tasks-head">
            <div>
              <span className="wb-eyebrow">TASKS</span>
              <h1 className="wb-tasks-title">把下一步写下来。</h1>
              <p className="wb-tasks-sub">{summary}</p>
            </div>
            <button
              type="button"
              className="wb-btn-primary"
              onClick={() => inputRef.current?.focus()}
            >
              <Plus size={14} /> 新建任务
            </button>
          </header>
        )}

        {viewMode !== "matrix" && (
        <section className="wb-overview">
          <div className="wb-stats">
            <div className="wb-stat">
              <strong>{counts.today}</strong>
              <span>今天</span>
            </div>
            <div className="wb-stat">
              <strong>{upcomingCount}</strong>
              <span>接下来</span>
            </div>
            <div className={cn("wb-stat", overdueTasks.length > 0 && "is-alert")}>
              <strong>{overdueTasks.length}</strong>
              <span>逾期</span>
            </div>
          </div>
          <span className="wb-ov-sep" />
          <div className="wb-sched">
            <div className="wb-sched-head">
              <span>排期</span>
              <span>
                已排期 {scheduledCount} / {open.length}
              </span>
            </div>
            <div className="wb-sched-bar">
              {Array.from({ length: Math.max(open.length, 1) }, (_, index) => (
                <i key={index} className={index < scheduledCount ? "is-on" : ""} />
              ))}
            </div>
            <div className="wb-sched-note">
              {scheduledCount} 个有截止日期 · {noDateTasks.length} 个待安排
            </div>
          </div>
        </section>
        )}

        {tagFilter && (
          <div className="task-tag-banner">
            <span className="task-tag-banner-label">
              <Tag size={12} /> 只看标签 <strong>#{tagFilter}</strong>
            </span>
            <div className="task-tag-banner-actions">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => openTagView(tagFilter)}>
                打开标签页
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTagFilter(null)}>
                清除筛选
              </button>
            </div>
          </div>
        )}

        {(viewMode !== "matrix" || quickOpen) && (
          <div className={viewMode === "matrix" ? "task-quick-layer" : undefined}>
            {viewMode === "matrix" && (
              <div className="task-quick-head">
                <span className="task-quick-title">新建任务</span>
                <span className="task-quick-hint">Enter 添加 · Esc 关闭</span>
                <button
                  type="button"
                  className="task-quick-close"
                  aria-label="关闭快捷新建"
                  onClick={closeQuickEntry}
                >
                  ×
                </button>
              </div>
            )}
            <form
              className="task-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            void addTask();
          }}
        >
          <div className="task-add-bar">
            <div className="task-add-input">
              <span className="wb-plus-badge">
                <Plus size={11} />
              </span>
              <input
                ref={inputRef}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="记下一件要做的事…"
                aria-label="新任务标题"
              />
            </div>
            <div className="task-add-controls">
              {newQuadrant && (
                <span className={cn("task-add-quadrant", newQuadrant)}>
                  <i />
                  {quadrantMeta(newQuadrant).title}
                  <button type="button" aria-label="取消指定象限" onClick={() => setNewQuadrant(null)}>
                    ×
                  </button>
                </span>
              )}
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
              <button
                type="button"
                className={cn("task-add-tag-btn", (tagRowOpen || newTags.length > 0) && "is-active")}
                onClick={() => setTagRowOpen(true)}
                title="给任务加标签"
                aria-expanded={tagRowOpen || newTags.length > 0}
              >
                <Tag size={13} />
                <span>
                  {newTags.length
                    ? `#${newTags[0]}${newTags.length > 1 ? ` +${newTags.length - 1}` : ""}`
                    : "标签"}
                </span>
              </button>
              <button type="submit" className="btn btn-primary task-add-submit" disabled={!title.trim() || adding}>
                <Plus size={15} /> 添加
              </button>
            </div>
          </div>

          {tagRowOpen && (
            <div className="task-add-tag-row">
              <TagInput
                tags={newTags}
                suggestions={tagSuggestions}
                onChange={(tags) => {
                  setNewTags(tags);
                  if (!tags.length) setTagRowOpen(false);
                }}
                autoOpen
                compact
                max={5}
                placeholder="输入标签，回车确认"
                addLabel="加标签"
              />
              <span className="task-add-tag-hint">回车确认，可加多个</span>
              <button type="button" className="task-add-tag-done" onClick={() => setTagRowOpen(false)}>
                收起
              </button>
            </div>
          )}
            </form>
          </div>
        )}

        {viewMode !== "matrix" && (
        <div className="tasks-toolbar">
          {viewMode === "list" ? (
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
          ) : (
            <span className="calendar-mode-hint">所有未完成任务 · 按截止日期分布</span>
          )}
          {viewMode === "list" && (
            <span className="tasks-toolbar-note">
              {filter === "done"
                ? `已完成的每一小步都算数 · 共 ${done.length} 件`
                : filter === "today"
                  ? "今天的截止任务"
                  : filter === "upcoming"
                    ? "已排期按日期，其余待安排"
                    : `${open.length} 个未完成 · ${scheduledCount} 个有截止日期`}
            </span>
          )}
        </div>
        )}

        {viewMode === "list" ? (
        <div className="task-groups">
          {isEmpty ? (
            <div className="task-empty">
              <div className="task-empty-icon">
                {filter === "done" ? <CheckCheck size={22} /> : <ListTodo size={22} />}
              </div>
              <h3 className="display">
                {filter === "done"
                  ? tagFilter
                    ? `#${tagFilter} 下还没有完成的任务`
                    : "还没有完成的任务"
                  : filter === "today"
                    ? tagFilter
                      ? `#${tagFilter} 下今天没有安排`
                      : "今天，暂时没有安排"
                    : filter === "upcoming"
                      ? tagFilter
                        ? `#${tagFilter} 下接下来是空的`
                        : "接下来是空的"
                      : tagFilter
                        ? `#${tagFilter} 下还没有任务`
                        : "所有事情都清空了"}
              </h3>
              <p>
                {filter === "done"
                  ? "完成一件小事后，它会出现在这里。"
                  : tagFilter
                    ? "换个标签看看，或者现在记一件带这个标签的事。"
                    : "给自己留一点空白，或者现在写下一件事。"}
              </p>
              {filter !== "done" && (
                <button
                  type="button"
                  className="btn btn-outline"
                  onClick={() => {
                    if (tagFilter) {
                      setNewTags([tagFilter]);
                      setTagRowOpen(true);
                    }
                    inputRef.current?.focus();
                  }}
                >
                  <Plus size={14} /> {tagFilter ? `用 #${tagFilter} 记一件事` : "记一件事"}
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
                    {group.key === "today" && <span className="task-group-note tone-today">今天截止</span>}
                    {group.key.startsWith("date-") && (
                      <span className={cn("task-group-note", `tone-${remainingLabel(group.key.slice(5)).tone}`)}>
                        {remainingLabel(group.key.slice(5)).label}
                      </span>
                    )}
                    {group.key === "nodate" && <span className="task-group-note">还没排期</span>}
                  </div>
                  <div className="task-group-list">
                    {group.tasks.map((task: Task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        note={task.noteId ? noteMap.get(task.noteId) : undefined}
                        showCompletedAt={filter === "done"}
                        inline
                      />
                    ))}
                  </div>
                </section>
              ) : null,
            )
          )}
        </div>
        ) : viewMode === "calendar" ? (
          <TaskCalendar tasks={open} notes={notes} onShowList={() => setViewMode("list")} />
        ) : (
          <TaskMatrix
            tasks={filter === "today" ? dueTodayTasks : filter === "upcoming" ? [...upcomingTasks, ...noDateTasks] : open}
            onAddToQuadrant={addTaskToQuadrant}
            onNewTask={openQuickEntry}
          />
        )}

        {viewMode === "matrix" && (
          <TaskOverviewBand
            tasks={allTasks}
            notes={notes}
            onShowDone={showDone}
            onOpenAssistant={() => {
              setAssistantDraft(
                "帮我把现在没完成的任务按「重要 × 紧急」分到四个象限里，并给我一个建议顺序：先做哪三件、为什么。",
              );
              setView("assistant");
            }}
          />
        )}

        <div className="tasks-footer">
          <span>
            <Sparkles size={13} /> 不知道从哪开始？让 AI 帮你理一下。
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setView("assistant")}>
            打开 AI 助手
          </button>
        </div>
        </div>
        {viewMode !== "matrix" && <TasksRail tasks={tasks} notes={notes} />}
      </div>
    </div>
  );
}
