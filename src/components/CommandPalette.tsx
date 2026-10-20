import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowRight,
  CheckSquare,
  FilePlus2,
  FileText,
  Moon,
  NotebookPen,
  Search,
  Settings2,
  Sparkles,
  Sunrise,
} from "lucide-react";
import { db, createNote, createTask } from "../db";
import { useUI } from "../store/ui";
import { searchNotes, searchTasks } from "../lib/search";
import { cn, dayKey, dueLabel, noteTitle } from "../lib/util";
import type { Note, Task } from "../types";

type PaletteItem =
  | { kind: "note"; note: Note; key: string }
  | { kind: "task"; task: Task; key: string }
  | { kind: "action"; label: string; hint?: string; icon: typeof Search; key: string; run: () => void };

export function CommandPalette() {
  const open = useUI((state) => state.commandOpen);
  const setOpen = useUI((state) => state.setCommandOpen);
  const openNote = useUI((state) => state.openNote);
  const setView = useUI((state) => state.setView);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);
  const setTaskFilter = useUI((state) => state.setTaskFilter);
  const theme = useUI((state) => state.theme);
  const setTheme = useUI((state) => state.setTheme);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const actions = useMemo(
    () => [
      {
        label: "新建笔记",
        hint: "⌘ N",
        icon: FilePlus2,
        run: async () => {
          const note = await createNote();
          openNote(note.id);
          setOpen(false);
        },
      },
      {
        label: "新建任务",
        hint: "今天",
        icon: CheckSquare,
        run: async () => {
          const task = await createTask({ dueDate: dayKey() });
          setTaskFilter("all");
          setTaskDetailId(task.id);
          setView("tasks");
          setOpen(false);
        },
      },
      {
        label: "打开今日",
        hint: "总览",
        icon: Sunrise,
        run: () => {
          setView("today");
          setOpen(false);
        },
      },
      {
        label: "打开 AI 助手",
        hint: "问答",
        icon: Sparkles,
        run: () => {
          setView("assistant");
          setOpen(false);
        },
      },
      {
        label: "设置与数据",
        hint: "⌘ ,",
        icon: Settings2,
        run: () => {
          setSettingsOpen(true);
          setOpen(false);
        },
      },
      {
        label: theme === "dark" ? "切换到浅色模式" : "切换到深色模式",
        hint: "外观",
        icon: Moon,
        run: () => {
          setTheme(theme === "dark" ? "light" : "dark");
          setOpen(false);
        },
      },
    ],
    [openNote, setOpen, setSettingsOpen, setTaskDetailId, setTaskFilter, setTheme, setView, theme],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      const recent = notes
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4)
        .map((note): PaletteItem => ({ kind: "note", note, key: `note-${note.id}` }));
      return [
        ...actions.map((action): PaletteItem => ({ kind: "action", ...action, key: `action-${action.label}` })),
        ...recent,
      ];
    }
    const noteHits = searchNotes(notes, trimmed)
      .slice(0, 6)
      .map((note): PaletteItem => ({ kind: "note", note, key: `note-${note.id}` }));
    const taskHits = searchTasks(tasks, trimmed)
      .slice(0, 4)
      .map((task): PaletteItem => ({ kind: "task", task, key: `task-${task.id}` }));
    const actionHits = actions
      .filter((action) => action.label.includes(trimmed) || trimmed.includes(action.label.slice(0, 2)))
      .map((action): PaletteItem => ({ kind: "action", ...action, key: `action-${action.label}` }));
    return [...noteHits, ...taskHits, ...actionHits];
  }, [actions, notes, query, tasks]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(".cmdk-item.is-active");
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!open) return null;

  const execute = (item: PaletteItem) => {
    if (item.kind === "note") {
      openNote(item.note.id);
      setOpen(false);
    } else if (item.kind === "task") {
      setTaskFilter("all");
      setView("tasks");
      setTaskDetailId(item.task.id);
      setOpen(false);
    } else {
      void item.run();
    }
  };

  const sections = items.reduce<Record<string, PaletteItem[]>>((groups, item) => {
    const key = item.kind === "note" ? (query.trim() ? "笔记" : "最近笔记") : item.kind === "task" ? "任务" : "快捷操作";
    groups[key] = groups[key] ?? [];
    groups[key].push(item);
    return groups;
  }, {});

  let absoluteIndex = -1;

  return createPortal(
    <div
      className="cmdk-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="cmdk-search">
          <Search size={18} style={{ color: "var(--muted)", flexShrink: 0 }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索笔记、任务，或输入命令…"
            aria-label="搜索"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => Math.min(items.length - 1, index + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = items[activeIndex];
                if (item) execute(item);
              }
            }}
          />
          <span className="kbd">esc</span>
        </div>

        <div className="cmdk-results" ref={listRef}>
          {items.length === 0 && (
            <div className="cmdk-empty">
              <p>没有找到「{query}」</p>
              <span>换个关键词，或者新建一篇笔记。</span>
            </div>
          )}
          {Object.entries(sections).map(([section, sectionItems]) => (
            <div className="cmdk-section" key={section}>
              <div className="cmdk-section-label">{section}</div>
              {sectionItems.map((item) => {
                absoluteIndex += 1;
                const index = absoluteIndex;
                const active = index === activeIndex;
                return (
                  <button
                    type="button"
                    key={item.key}
                    className={cn("cmdk-item", active && "is-active")}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => execute(item)}
                  >
                    <span className="cmdk-item-icon">
                      {item.kind === "note" ? (
                        <FileText size={16} />
                      ) : item.kind === "task" ? (
                        <CheckSquare size={16} />
                      ) : (
                        <item.icon size={16} />
                      )}
                    </span>
                    <span className="cmdk-item-text">
                      {item.kind === "note" && (
                        <>
                          <strong>{noteTitle(item.note.title)}</strong>
                          <span>{item.note.tags.slice(0, 2).map((tag) => `#${tag}`).join(" · ") || "笔记"}</span>
                        </>
                      )}
                      {item.kind === "task" && (
                        <>
                          <strong>{item.task.title}</strong>
                          <span>{item.task.done ? "已完成" : item.task.dueDate ? dueLabel(item.task.dueDate).label : "无日期"} · 任务</span>
                        </>
                      )}
                      {item.kind === "action" && (
                        <>
                          <strong>{item.label}</strong>
                          {item.hint && <span>{item.hint}</span>}
                        </>
                      )}
                    </span>
                    {item.kind === "action" && item.hint && <span className="cmdk-hint">{item.hint}</span>}
                    <ArrowRight size={14} className="cmdk-go" />
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="cmdk-footer">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> 选择
          </span>
          <span>
            <span className="kbd">↵</span> 打开
          </span>
          <span>
            <span className="kbd">esc</span> 关闭
          </span>
          <span className="cmdk-brand">
            <NotebookPen size={12} /> lafei
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
