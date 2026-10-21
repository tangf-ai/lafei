import {
  CheckSquare,
  Moon,
  NotebookPen,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  Sunrise,
  Tag,
} from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, createNote } from "../db";
import { useUI } from "../store/ui";
import { useFolderSync } from "../store/folderSync";
import { cn, dayKey, isOverdue } from "../lib/util";
import { collectTagCounts, sameTag } from "../lib/tags";
import { Logo } from "./Logo";

const NAV = [
  { id: "today", label: "今日", icon: Sunrise },
  { id: "notes", label: "笔记", icon: NotebookPen },
  { id: "tasks", label: "任务", icon: CheckSquare },
  { id: "tags", label: "标签", icon: Tag },
  { id: "assistant", label: "AI 助手", icon: Sparkles },
] as const;

export function Sidebar() {
  const view = useUI((state) => state.view);
  const setView = useUI((state) => state.setView);
  const openNote = useUI((state) => state.openNote);
  const tagFilter = useUI((state) => state.tagFilter);
  const setTagFilter = useUI((state) => state.setTagFilter);
  const openTagView = useUI((state) => state.openTagView);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const theme = useUI((state) => state.theme);
  const setTheme = useUI((state) => state.setTheme);
  const sidebarCollapsed = useUI((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useUI((state) => state.setSidebarCollapsed);
  const folderRoot = useUI((state) => state.folderRoot);
  const syncPhase = useFolderSync((state) => state.phase);

  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const openTasks = tasks.filter((task) => !task.done);
  const today = dayKey();
  const dueCount = openTasks.filter((task) => task.dueDate === today || isOverdue(task.dueDate)).length;

  const tagCounts = collectTagCounts(notes, tasks);
  const tags = tagCounts.slice(0, 9);

  const startNote = async () => {
    const note = await createNote();
    openNote(note.id);
  };

  const toggleTheme = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  return (
    <aside className={cn("sidebar", sidebarCollapsed && "is-collapsed")} data-tauri-drag-region>
      <div className="sidebar-top">
        <Logo />
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-pressed={sidebarCollapsed}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>
      </div>

      <button
        type="button"
        className="sidebar-new"
        onClick={() => void startNote()}
        title="新建笔记"
        aria-label="新建笔记"
      >
        <Plus size={16} strokeWidth={2} />
        <span className="sidebar-new-label">新建笔记</span>
        <span className="kbd">⌘N</span>
      </button>

      <div className="sidebar-scroll">
        <nav className="nav-group" aria-label="主导航">
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn("nav-item", isActive && "active")}
                title={item.label}
                onClick={() => {
                  setView(item.id);
                  setTagFilter(null);
                }}
              >
                <Icon size={17} strokeWidth={1.8} />
                <span className="nav-item-label">{item.label}</span>
                {item.id === "notes" && notes.length > 0 && <span className="nav-count">{notes.length}</span>}
                {item.id === "tasks" && openTasks.length > 0 && (
                  <span className={cn("nav-count", dueCount > 0 && "is-accent")}>{openTasks.length}</span>
                )}
                {item.id === "assistant" && (
                  <span className="nav-count" style={{ fontSize: 9, letterSpacing: ".04em" }}>
                    AI
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="nav-group sidebar-tags">
          <div className="nav-label">
            标签
            <span style={{ letterSpacing: 0 }}>{tags.length ? `${tagCounts.length}` : ""}</span>
          </div>
          {tags.length > 0 ? (
            <div className="tag-list">
              {tags.map((item) => {
                const active = view === "tags" && tagFilter !== null && sameTag(tagFilter, item.tag);
                return (
                  <button
                    key={item.tag}
                    type="button"
                    className={cn("tag-item", active && "active")}
                    title={`${item.openTasks} 个待办 · ${item.notes} 篇笔记`}
                    onClick={() => {
                      if (active) setTagFilter(null);
                      else openTagView(item.tag);
                    }}
                  >
                    <span className="tag-hash">#</span>
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.tag}
                    </span>
                    <span className="tag-count">{item.total}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="empty-tags">给笔记或任务加上标签，它们会出现在这里。</p>
          )}
        </div>
      </div>

      <div className="sidebar-foot">
        <div className="local-note">
          <span
            className={cn(
              "local-dot",
              folderRoot && syncPhase === "error" && "is-error",
              folderRoot && syncPhase === "syncing" && "is-syncing",
            )}
          />
          {folderRoot
            ? syncPhase === "syncing"
              ? "文件夹同步中…"
              : syncPhase === "error"
                ? "文件夹同步异常"
                : "文件夹存储 · 已连接"
            : "本地存储 · 数据属于你"}
        </div>
        <div className="sidebar-user-row">
          <button type="button" className="sidebar-user" onClick={() => setSettingsOpen(true)}>
            <span className="avatar">L</span>
            <span className="sidebar-user-info">
              <strong>我的空间</strong>
              <span>{notes.length} 篇笔记 · {openTasks.length} 个待办</span>
            </span>
            <Settings2 size={14} style={{ opacity: 0.55 }} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-sm sidebar-theme"
            title={theme === "dark" ? "切换到浅色" : "切换到深色"}
            aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
