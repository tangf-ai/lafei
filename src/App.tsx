import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { MobileTopbar } from "./components/MobileTopbar";
import { MobileNav } from "./components/MobileNav";
import { CommandPalette } from "./components/CommandPalette";
import { TaskDetailModal } from "./components/TaskDetail";
import { Toasts } from "./components/Toasts";
import { TodayView } from "./views/TodayView";
import { NotesView } from "./views/NotesView";
import { TasksView } from "./views/TasksView";
import { TagView } from "./views/TagView";
import { AssistantView } from "./views/AssistantView";
import { SettingsView } from "./views/SettingsView";
import { useUI } from "./store/ui";
import { useIsMobile, useResolvedTheme } from "./lib/hooks";
import { applyFontScale } from "./lib/fontScale";
import { newNote } from "./lib/actions";
import { createTask } from "./db";
import { dayKey } from "./lib/util";
import { cn } from "./lib/util";

const THEME_COLORS: Record<string, string> = {
  light: "#F3F4F0",
  dark: "#161913",
  sunny: "#FBF2DF",
  mint: "#EAF3E5",
  sea: "#EDF4F6",
};

export default function App() {
  const view = useUI((state) => state.view);
  const activeNoteId = useUI((state) => state.activeNoteId);
  const theme = useUI((state) => state.theme);
  const fontScale = useUI((state) => state.fontScale);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const setCommandOpen = useUI((state) => state.setCommandOpen);
  const setView = useUI((state) => state.setView);
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);
  const sidebarCollapsed = useUI((state) => state.sidebarCollapsed);
  const resolvedTheme = useResolvedTheme(theme);
  const isMobile = useIsMobile();
  const editorOpen = isMobile && view === "notes" && Boolean(activeNoteId);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme === "dark" ? "dark" : "light";
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", THEME_COLORS[resolvedTheme] ?? THEME_COLORS.light);
  }, [resolvedTheme]);

  useEffect(() => {
    applyFontScale(fontScale);
  }, [fontScale]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (key === "n") {
        event.preventDefault();
        if (event.shiftKey) {
          void createTask({ title: "", dueDate: dayKey() }).then((task) => {
            useUI.getState().setTaskFilter("all");
            setView("tasks");
            setTaskDetailId(task.id);
          });
        } else {
          void newNote();
        }
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setCommandOpen, setSettingsOpen, setTaskDetailId, setView]);

  return (
    <div
      className={cn("app-shell", editorOpen && "editor-open", sidebarCollapsed && "wb-collapsed")}
      data-tauri-drag-region
    >
      <Topbar />
      <Sidebar />
      <div className="app-main">
        {!editorOpen && <MobileTopbar />}
        {view === "today" && <TodayView />}
        {view === "notes" && <NotesView />}
        {view === "tasks" && <TasksView />}
        {view === "tags" && <TagView />}
        {view === "assistant" && <AssistantView />}
        {!editorOpen && <MobileNav />}
      </div>
      <CommandPalette />
      <SettingsView />
      <TaskDetailModal />
      <Toasts />
    </div>
  );
}
