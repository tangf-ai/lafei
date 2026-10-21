import { CheckSquare, NotebookPen, Sparkles, Sunrise, Tag } from "lucide-react";
import { useUI } from "../store/ui";
import type { AppView } from "../types";

const ITEMS: Array<{ id: AppView; label: string; icon: typeof Sunrise }> = [
  { id: "today", label: "今日", icon: Sunrise },
  { id: "notes", label: "笔记", icon: NotebookPen },
  { id: "tasks", label: "任务", icon: CheckSquare },
  { id: "tags", label: "标签", icon: Tag },
  { id: "assistant", label: "AI", icon: Sparkles },
];

export function MobileNav() {
  const view = useUI((state) => state.view);
  const setView = useUI((state) => state.setView);
  const setTagFilter = useUI((state) => state.setTagFilter);
  return (
    <nav className="mobile-nav" aria-label="移动端主导航">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            className={`mobile-nav-item ${view === item.id ? "active" : ""} ${item.id === "assistant" ? "assistant" : ""}`}
            onClick={() => {
              setTagFilter(null);
              setView(item.id);
            }}
          >
            <span className="mobile-nav-icon">
              <Icon size={19} strokeWidth={view === item.id ? 2.1 : 1.75} />
            </span>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
