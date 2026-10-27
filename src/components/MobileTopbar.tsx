import { CalendarDays, LayoutGrid, List, Search, Settings2 } from "lucide-react";
import { useUI } from "../store/ui";
import type { TaskViewMode } from "../types";
import { cn, shortDate } from "../lib/util";

const TASK_VIEWS: { id: TaskViewMode; label: string; icon: typeof List }[] = [
  { id: "list", label: "列表视图", icon: List },
  { id: "matrix", label: "矩阵视图", icon: LayoutGrid },
  { id: "calendar", label: "日历视图", icon: CalendarDays },
];

export function MobileTopbar() {
  const setCommandOpen = useUI((state) => state.setCommandOpen);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const view = useUI((state) => state.view);
  const filter = useUI((state) => state.taskFilter);
  const setTaskFilter = useUI((state) => state.setTaskFilter);
  const taskView = useUI((state) => state.taskView);
  const setTaskView = useUI((state) => state.setTaskView);
  return (
    <header className="mobile-topbar">
      <div className="mobile-brand">
        <div className="brand-mark" aria-hidden="true">
          <span>l</span>
        </div>
        <span className="mobile-wordmark">
          lafei<span>.</span>
        </span>
      </div>
      <div className="mobile-topbar-actions">
        {view === "tasks" && (
          <div className="wb-task-view is-mobile" role="group" aria-label="任务视图">
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
                  <Icon size={15} />
                </button>
              );
            })}
          </div>
        )}
        <span className="mobile-topbar-date">{shortDate()}</span>
        <button type="button" className="icon-btn" aria-label="搜索" onClick={() => setCommandOpen(true)}>
          <Search size={18} />
        </button>
        <button type="button" className="icon-btn" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={18} />
        </button>
      </div>
    </header>
  );
}
