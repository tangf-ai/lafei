import { useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  CheckSquare,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Sparkles,
  Sunrise,
  Tag,
} from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { useUI } from "../store/ui";
import { useFolderSync } from "../store/folderSync";
import { cn, dayKey, isOverdue } from "../lib/util";
import { collectTagCounts, sameTag } from "../lib/tags";
import type { TaskFilter } from "../types";

/** 侧栏宽度范围与默认值（拖动右侧边缘调整） */
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 380;
const SIDEBAR_DEFAULT = 236;

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)));
}

const NAV = [
  { id: "today", label: "今日", icon: Sunrise },
  { id: "notes", label: "笔记", icon: NotebookPen },
  { id: "tasks", label: "任务", icon: CheckSquare },
  { id: "tags", label: "标签", icon: Tag },
  { id: "assistant", label: "AI 助手", icon: Sparkles },
] as const;

const VIEWS: Array<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "today", label: "今天" },
  { id: "upcoming", label: "接下来" },
  { id: "done", label: "已完成" },
];

const TAG_COLORS = ["#6E8B7A", "#B57B24", "#7A8290", "#A86B58", "#8A8F5C", "#4C7D86", "#8B6A9B"];

function tagColor(tag: string) {
  let hash = 0;
  for (let index = 0; index < tag.length; index += 1) hash = (hash * 31 + tag.charCodeAt(index)) >>> 0;
  return TAG_COLORS[hash % TAG_COLORS.length];
}

export function Sidebar() {
  const view = useUI((state) => state.view);
  const setView = useUI((state) => state.setView);
  const tagFilter = useUI((state) => state.tagFilter);
  const setTagFilter = useUI((state) => state.setTagFilter);
  const openTagView = useUI((state) => state.openTagView);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const taskFilter = useUI((state) => state.taskFilter);
  const setTaskFilter = useUI((state) => state.setTaskFilter);
  const sidebarCollapsed = useUI((state) => state.sidebarCollapsed);
  const sidebarWidth = useUI((state) => state.sidebarWidth);
  const setSidebarWidth = useUI((state) => state.setSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeActiveRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(SIDEBAR_DEFAULT);
  const resizeLastWidthRef = useRef(SIDEBAR_DEFAULT);

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const start = clampSidebarWidth(sidebarWidth);
    resizeActiveRef.current = true;
    resizeStartXRef.current = event.clientX;
    resizeStartWidthRef.current = start;
    resizeLastWidthRef.current = start;
    setResizing(true);
    document.body.classList.add("is-col-resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeActiveRef.current) return;
    const next = clampSidebarWidth(
      resizeStartWidthRef.current + (event.clientX - resizeStartXRef.current),
    );
    if (next === resizeLastWidthRef.current) return;
    resizeLastWidthRef.current = next;
    setSidebarWidth(next);
  };

  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeActiveRef.current) return;
    resizeActiveRef.current = false;
    setResizing(false);
    document.body.classList.remove("is-col-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth(clampSidebarWidth(sidebarWidth + (event.key === "ArrowLeft" ? -16 : 16)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MAX);
    }
  };

  const setSidebarCollapsed = useUI((state) => state.setSidebarCollapsed);
  const folderRoot = useUI((state) => state.folderRoot);
  const syncPhase = useFolderSync((state) => state.phase);

  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const openTasks = tasks.filter((task) => !task.done);
  const doneTasks = tasks.filter((task) => task.done);
  const today = dayKey();
  const todayCount = openTasks.filter((task) => task.dueDate === today).length;
  const upcomingCount = openTasks.filter((task) => !task.dueDate || task.dueDate > today).length;

  const viewCounts: Record<TaskFilter, number> = {
    all: openTasks.length,
    today: todayCount,
    upcoming: upcomingCount,
    done: doneTasks.length,
  };

  const tagCounts = collectTagCounts(notes, tasks);
  const tags = tagCounts.slice(0, 9);
  const hasOverdue = openTasks.some((task) => isOverdue(task.dueDate));

  const openTag = (tag: string) => {
    if (view === "tags" && tagFilter !== null && sameTag(tagFilter, tag)) setTagFilter(null);
    else openTagView(tag);
  };

  const openTaskView = (filter: TaskFilter) => {
    setView("tasks");
    setTaskFilter(filter);
  };

  return (
    <aside
      className={cn("sidebar", "wb-sidebar", sidebarCollapsed && "is-collapsed")}
      data-tauri-drag-region
    >
      {!sidebarCollapsed && (
        <div
          className="wb-side-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整侧栏宽度，双击恢复默认"
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          title="拖动调整侧栏宽度，双击恢复默认"
          data-dragging={resizing ? "true" : undefined}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT)}
          onKeyDown={handleResizeKeyDown}
        />
      )}
      <div className="wb-side-top" data-tauri-drag-region>
        <div className="wb-brand">
          lafei<span>.</span>
        </div>
        <button
          type="button"
          className="wb-collapse"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-pressed={sidebarCollapsed}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      <div className="wb-side-scroll">
        <nav className="wb-nav-group" aria-label="主导航">
          <div className="wb-group-label">工作区</div>
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn("wb-nav-item", isActive && "active")}
                title={item.label}
                onClick={() => {
                  setView(item.id);
                  setTagFilter(null);
                }}
              >
                <Icon size={16} strokeWidth={1.7} />
                <span>{item.label}</span>
                {item.id === "notes" && notes.length > 0 && <span className="wb-count">{notes.length}</span>}
                {item.id === "tasks" && openTasks.length > 0 && (
                  <span className={cn("wb-count", hasOverdue && "is-accent")}>{openTasks.length}</span>
                )}
                {item.id === "assistant" && <span className="wb-ai-badge">AI</span>}
              </button>
            );
          })}
        </nav>

        <nav className="wb-nav-group" aria-label="任务视图">
          <div className="wb-group-label">视图</div>
          {VIEWS.map((item) => {
            const isActive = view === "tasks" && taskFilter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn("wb-view-item", isActive && "active")}
                onClick={() => openTaskView(item.id)}
              >
                <span>{item.label}</span>
                <span className="wb-count">{viewCounts[item.id]}</span>
              </button>
            );
          })}
        </nav>

        <nav className="wb-nav-group sidebar-tags" aria-label="标签">
          <div className="wb-group-label">
            标签
            <span>{tagCounts.length}</span>
          </div>
          {tags.length > 0 ? (
            <div className="wb-tag-list">
              {tags.map((item) => {
                const active = view === "tags" && tagFilter !== null && sameTag(tagFilter, item.tag);
                return (
                  <button
                    key={item.tag}
                    type="button"
                    className={cn("wb-tag-item", active && "active")}
                    title={`${item.openTasks} 个待办 · ${item.notes} 篇笔记`}
                    onClick={() => openTag(item.tag)}
                  >
                    <span className="wb-tag-dot" style={{ background: tagColor(item.tag) }} />
                    <span className="wb-tag-hash">#</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.tag}
                    </span>
                    <span className="wb-count">{item.total}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="wb-empty-tags">给笔记或任务加上标签，它们会出现在这里。</p>
          )}
        </nav>
      </div>

      <div className="wb-side-bottom">
        <div
          className={cn(
            "wb-storage",
            folderRoot && syncPhase === "error" && "is-error",
            folderRoot && syncPhase === "syncing" && "is-syncing",
          )}
        >
          <i />
          {folderRoot
            ? syncPhase === "syncing"
              ? "文件夹同步中…"
              : syncPhase === "error"
                ? "文件夹同步异常"
                : "文件夹存储 · 已连接"
            : "本地存储 · 数据属于你"}
        </div>
        <button type="button" className="wb-user" onClick={() => setSettingsOpen(true)}>
          <span className="wb-user-avatar">L</span>
          <span className="wb-user-meta">
            <span className="wb-user-name">我的空间</span>
            <span className="wb-user-sub">
              {notes.length} 篇笔记 · {openTasks.length} 个待办
            </span>
          </span>
          <span className="wb-user-icons">
            <Settings2 size={14} />
          </span>
        </button>
      </div>
    </aside>
  );
}
