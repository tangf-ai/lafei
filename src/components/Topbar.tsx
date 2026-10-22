import { Moon, Plus, Search, Sun } from "lucide-react";
import { format } from "date-fns";
import { useUI } from "../store/ui";
import { useNow, useResolvedTheme } from "../lib/hooks";
import { newNote } from "../lib/actions";
import type { AppView, TaskFilter } from "../types";

const VIEW_LABEL: Record<AppView, string> = {
  today: "今日",
  notes: "笔记",
  tasks: "任务",
  tags: "标签",
  assistant: "AI 助手",
};

const FILTER_LABEL: Record<TaskFilter, string> = {
  all: "全部",
  today: "今天",
  upcoming: "接下来",
  done: "已完成",
};

export function Topbar() {
  const view = useUI((state) => state.view);
  const filter = useUI((state) => state.taskFilter);
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
