import { CalendarDays, LayoutGrid, List, Moon, Plus, Search, Sun } from "lucide-react";
import { format } from "date-fns";
import { useUI } from "../store/ui";
import { useNow, useResolvedTheme } from "../lib/hooks";
import { newNote } from "../lib/actions";
import type { AppView, TaskFilter, TaskViewMode } from "../types";
import { cn } from "../lib/util";

const VIEW_LABEL: Record<AppView, string> = {
  today: "今日",
  notes: "笔记",
  tasks: "任务",
  tags: "标签",
  assistant: "AI 助手",
};

const TASK_VIEWS: { id: TaskViewMode; label: string; icon: typeof List }[] = [
  { id: "list", label: "列表视图", icon: List },
  { id: "matrix", label: "矩阵视图", icon: LayoutGrid },
  { id: "calendar", label: "日历视图", icon: CalendarDays },
];

const FILTER_LABEL: Record<TaskFilter, string> = {
  all: "全部",
  today: "今天",
  upcoming: "接下来",
  done: "已完成",
};

export function Topbar() {
  const view = useUI((state) => state.view);
  const filter = useUI((state) => state.taskFilter);
  const setTaskFilter = useUI((state) => state.setTaskFilter);
  const taskView = useUI((state) => state.taskView);
  const setTaskView = useUI((state) => state.setTaskView);
  const tagFilter = useUI((state) => state.tagFilter);
  const theme = useUI((state) => state.theme);
  const setTheme = useUI((state) => state.setTheme);
  const setCommandOpen = useUI((state) => state.setCommandOpen);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const resolvedTheme = useResolvedTheme(theme);
  const isDark = resolvedTheme === "dark";
  const now = useNow(30_000);

  const crumbSecondary =
    view === "tasks" ? FILTER_LABEL[filter] : view === "notes" ? "所有笔记" : view === "tags" && tagFilter ? `#${tagFilter}` : null;

  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  return (
    <header className="wb-topbar" data-tauri-drag-region>
      <div className="wb-tb-left" data-tauri-drag-region>
        <span className="wb-ws">我的空间</span>
        <span className="wb-crumb">
          {VIEW_LABEL[view]}
          {crumbSecondary && (
            <>
              <i>/</i>
              <b>{crumbSecondary}</b>
            </>
          )}
        </span>
        {view === "tasks" && (
          <div className="wb-task-view" role="group" aria-label="任务视图">
            {TASK_VIEWS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn("wb-task-view-btn", taskView === item.id && "is-active")}
                  onClick={() => {
                    if (item.id === "matrix" && filter === "done") setTaskFilter("all");
                    setTaskView(item.id);
                  }}
                  title={item.label}
                  aria-label={item.label}
                  aria-pressed={taskView === item.id}
                >
                  <Icon size={13} />
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="wb-tb-center">
        <button
          type="button"
          className="wb-search"
          onClick={() => setCommandOpen(true)}
          title="搜索任务、笔记（⌘K）"
        >
          <Search size={13} />
          <span>搜索任务、笔记…</span>
          <kbd>⌘K</kbd>
        </button>
      </div>

      <div className="wb-tb-right">
        <span className="wb-clock" title={now.toLocaleString("zh-CN")}>
          {format(now, "HH:mm")}
        </span>
        <button type="button" className="wb-ghost" onClick={() => void newNote()} title="新建笔记（⌘N）">
          <Plus size={13} />
          新建笔记
          <kbd>⌘N</kbd>
        </button>
        <button
          type="button"
          className="wb-icon"
          onClick={toggleTheme}
          title={isDark ? "切换到浅色" : "切换到深色"}
          aria-label={isDark ? "切换到浅色模式" : "切换到深色模式"}
        >
          {isDark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          type="button"
          className="wb-avatar"
          onClick={() => setSettingsOpen(true)}
          title="打开设置"
          aria-label="打开设置"
        >
          L
        </button>
      </div>
    </header>
  );
}
