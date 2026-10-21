import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckSquare,
  ChevronRight,
  FileText,
  Plus,
  Sparkles,
  Square,
  Sunrise,
} from "lucide-react";
import { db, createNote, createTask } from "../db";
import { useUI, toast } from "../store/ui";
import { useIsMobile } from "../lib/hooks";
import {
  cn,
  dayKey,
  dueLabel,
  excerpt,
  greeting,
  isOverdue,
  longDate,
  noteTitle,
  shortDate,
  updatedLabel,
} from "../lib/util";
import { isAIConfigured, streamChat, AIError } from "../lib/ai";
import type { Note } from "../types";
import { TaskRow } from "../components/TaskRow";

export function TodayView() {
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const openNote = useUI((state) => state.openNote);
  const setView = useUI((state) => state.setView);
  const setTaskFilter = useUI((state) => state.setTaskFilter);
  const ai = useUI((state) => state.ai);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const isMobile = useIsMobile();

  const [quickTitle, setQuickTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const quickInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const today = dayKey();
  const focusTasks = tasks
    .filter((task) => !task.done && (task.dueDate === today || isOverdue(task.dueDate)))
    .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || a.dueDate!.localeCompare(b.dueDate!));
  const scheduledUpcoming = tasks
    .filter((task) => !task.done && task.dueDate && task.dueDate > today)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
  const undatedUpcoming = tasks
    .filter((task) => !task.done && !task.dueDate)
    .sort((a, b) => Number(b.priority === "high") - Number(a.priority === "high") || b.updatedAt - a.updatedAt);
  const upcomingAll = [...scheduledUpcoming, ...undatedUpcoming];
  const upcoming = upcomingAll.slice(0, 4);
  const completedToday = tasks.filter(
    (task) => task.done && task.completedAt && dayKey(new Date(task.completedAt)) === today,
  );
  const totalForRing = completedToday.length + focusTasks.length;
  const progress = totalForRing === 0 ? 0 : Math.round((completedToday.length / totalForRing) * 100);
  const recentNotes = notes.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
  const noteMap = new Map(notes.map((note) => [note.id, note]));
  const importantTask = focusTasks.find((task) => task.priority === "high") ?? focusTasks[0];
  const focusCardTask = importantTask ?? upcomingAll[0] ?? null;
  const focusCardKind = importantTask ? "今日重点" : upcomingAll[0] ? "下一件" : "今天留白";

  const localBrief = (() => {
    if (focusTasks.length === 0 && completedToday.length === 0) {
      return "今天还没有安排。写下最重要的一件事，剩下的交给时间。";
    }
    const parts: string[] = [];
    if (focusTasks.length) parts.push(`今天有 ${focusTasks.length} 件事等你处理`);
    if (completedToday.length) parts.push(`已经完成了 ${completedToday.length} 件`);
    if (importantTask) parts.push(`建议先做「${importantTask.title}」`);
    return `${parts.join("，")}。不用一次做完所有事，先推进最小的一步。`;
  })();

  const addQuickTask = async () => {
    const title = quickTitle.trim();
    if (!title) return;
    await createTask({ title, dueDate: today, priority: "medium" });
    setQuickTitle("");
    toast("已加入今天", "success");
  };

  const generateBrief = async () => {
    if (briefBusy) return;
    if (!isAIConfigured(ai)) {
      setSettingsOpen(true);
      return;
    }
    setBrief("");
    setBriefError("");
    setBriefBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const taskLines = [...focusTasks, ...upcomingAll, ...completedToday]
      .slice(0, 16)
      .map((task) => `- [${task.done ? "x" : " "}] ${task.title}${task.dueDate ? `（${dueLabel(task.dueDate).label}）` : "（待安排）"}`)
      .join("\n");
    const noteLines = recentNotes
      .map((note) => `《${noteTitle(note.title)}》：${excerpt(note.content, 160)}`)
      .join("\n");
    try {
      await streamChat({
        settings: ai,
        messages: [
          {
            role: "system",
            content:
              "你是 Lafei 的每日规划助手。你说话克制、具体、有温度。不要使用空洞的鼓励，不要罗列清单。",
          },
          {
            role: "user",
            content: `这是今天的任务和最近的笔记。请写一份简短的「今日简报」，总共不超过 180 字：
1. 用一两句话概括今天的重心（不是复述清单）
2. 指出一件最值得优先做的事，并说明为什么
3. 最后给一句简短的提醒

不要使用标题，不要超过三段。\n\n日期：${longDate()}\n\n任务：\n${taskLines || "（今天没有任务）"}\n\n最近的笔记：\n${noteLines || "（暂无笔记）"}`,
          },
        ],
        signal: controller.signal,
        maxTokens: 500,
        onDelta: (delta) => setBrief((current) => current + delta),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      setBriefError(error instanceof AIError ? error.message : "生成简报时出了点问题，请稍后再试。");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBriefBusy(false);
      }
    }
  };

  const stopBrief = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBriefBusy(false);
  };

  const saveBriefAsNote = async () => {
    const content = `# 今日简报 · ${shortDate()}\n\n${brief.trim()}\n\n---\n\n${focusTasks
      .map((task) => `- [ ] ${task.title}`)
      .join("\n")}`;
    const note = await createNote({ title: `今日简报 · ${shortDate()}`, content, tags: ["AI", "每日简报"] });
    openNote(note.id);
    toast("已保存为笔记", "success");
  };

  const ringRadius = 44;
  const circumference = 2 * Math.PI * ringRadius;

  return (
    <div className="view-scroll">
      <div className="page today-page">
        <header className="today-hero">
          <div className="today-hero-copy">
            <div className="today-eyebrow">
              <span className="today-date-icon">
                <Sunrise size={14} />
              </span>
              {longDate()}
            </div>
            <h1 className="today-greeting display">
              {greeting()}。今天，<em>做点重要的。</em>
            </h1>
            <p className="today-intro">
              {focusTasks.length > 0
                ? `今天还有 ${focusTasks.length} 件事，接下来 ${upcomingAll.length} 件${undatedUpcoming.length ? `（其中 ${undatedUpcoming.length} 件待安排）` : ""}。不必全部做完，先挑一件真正重要的。`
                : upcomingAll.length > 0
                  ? `今天先留白。接下来还有 ${upcomingAll.length} 件工作${undatedUpcoming.length ? `，其中 ${undatedUpcoming.length} 件还没安排日期` : ""}，可以提前看一眼。`
                  : "清单是空的。正好留一点空间，给突然出现的想法。"}
            </p>
            <div className="today-actions">
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={async () => {
                  const note = await createNote();
                  openNote(note.id);
                }}
              >
                <Plus size={16} /> 新建笔记
              </button>
              <button
                type="button"
                className="btn btn-outline btn-lg"
                onClick={() => {
                  setTaskFilter("all");
                  setView("tasks");
                }}
              >
                <CheckSquare size={16} /> 查看任务
              </button>
            </div>
          </div>

          <div className="today-hero-side">
            <button
              type="button"
              className={cn("today-focus-card", !focusCardTask && "is-empty")}
              onClick={() => {
                if (focusCardTask) {
                  useUI.getState().setTaskDetailId(focusCardTask.id);
                } else {
                  quickInputRef.current?.focus();
                  quickInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                }
              }}
              title={focusCardTask ? `打开任务：${focusCardTask.title}` : "快速添加今天的第一件事"}
            >
              <span className="today-focus-kicker">
                <span className="eyebrow">{focusCardKind}</span>
                {focusCardTask ? <ArrowUpRight size={14} /> : <Plus size={14} />}
              </span>
              <strong>
                {focusCardTask ? focusCardTask.title : "给今天留一件重要的事"}
              </strong>
              <span className="today-focus-meta">
                {focusCardTask
                  ? `${focusCardTask.dueDate ? dueLabel(focusCardTask.dueDate).label : "待安排"}${focusCardTask.priority === "high" ? " · 高优先级" : ""}`
                  : "从下面快速添加，或先看看接下来要做的事。"}
              </span>
            </button>

            <div className="today-progress-card">
              <div className="today-ring-wrap">
              <svg viewBox="0 0 112 112" className="today-ring">
                <circle cx="56" cy="56" r={ringRadius} className="today-ring-track" />
                <circle
                  cx="56"
                  cy="56"
                  r={ringRadius}
                  className="today-ring-value"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference - (circumference * progress) / 100}
                />
              </svg>
              <div className="today-ring-center">
                <strong>{progress}<span>%</span></strong>
                <span>今日进度</span>
              </div>
            </div>
            <div className="today-progress-info">
              <span className="eyebrow">今日完成</span>
              <p>
                <strong>{completedToday.length}</strong> / {totalForRing || 0} 件事
              </p>
              <div className="today-progress-bar">
                <span style={{ width: `${progress}%` }} />
              </div>
              <span className="today-progress-note">
                {progress >= 100 && totalForRing > 0
                  ? "今天的清单清空了，去休息一下。"
                  : completedToday.length > 0
                    ? "慢慢来，你已经在推进了。"
                    : "第一件事，从现在开始。"}
              </span>
              </div>
            </div>
          </div>
        </header>

        <div className="today-grid">
          <section className="today-card today-tasks-card">
            <div className="card-heading-row">
              <div>
                <span className="eyebrow">Today</span>
                <h2 className="card-title display">今天要做的事</h2>
              </div>
              <button
                type="button"
                className="card-link"
                onClick={() => {
                  setTaskFilter("all");
                  setView("tasks");
                }}
              >
                全部 <ArrowUpRight size={14} />
              </button>
            </div>

            <div className="quick-task">
              <span className="quick-task-plus">
                <Plus size={15} />
              </span>
              <input
                ref={quickInputRef}
                value={quickTitle}
                onChange={(event) => setQuickTitle(event.target.value)}
                placeholder="往今天加一件小事…"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addQuickTask();
                }}
                aria-label="快速添加今日任务"
              />
              <span className="quick-task-hint">今天 · Enter</span>
            </div>

            <div className="today-task-list">
              {focusTasks.length === 0 ? (
                <div className="today-tasks-empty">
                  <CheckSquare size={18} />
                  <p>今天的清单是空的。</p>
                  <span>可以从上面加一件小事，或者先去看看稍后的任务。</span>
                </div>
              ) : (
                focusTasks.slice(0, 5).map((task) => (
                  <TaskRow key={task.id} task={task} note={task.noteId ? noteMap.get(task.noteId) : undefined} />
                ))
              )}
            </div>

            {upcomingAll.length > 0 && (
              <div className="today-upcoming">
                <div className="card-mini-label">
                  <CalendarDays size={13} /> 接下来
                  <span className="today-upcoming-count">{upcomingAll.length}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setTaskFilter("upcoming");
                      setView("tasks");
                    }}
                  >
                    查看全部
                  </button>
                </div>
                {upcoming.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    className="upcoming-row"
                    onClick={() => useUI.getState().setTaskDetailId(task.id)}
                  >
                    <span>{task.title}</span>
                    <span className={cn("task-due", task.dueDate ? `tone-${dueLabel(task.dueDate).tone}` : "tone-none")}>
                      {task.dueDate ? dueLabel(task.dueDate).label : "待安排"}
                    </span>
                  </button>
                ))}
                {upcomingAll.length > upcoming.length && (
                  <button
                    type="button"
                    className="upcoming-more"
                    onClick={() => {
                      setTaskFilter("upcoming");
                      setView("tasks");
                    }}
                  >
                    还有 {upcomingAll.length - upcoming.length} 件接下来的任务
                    <ArrowRight size={12} />
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="today-card today-notes-card">
            <div className="card-heading-row">
              <div>
                <span className="eyebrow">Journal</span>
                <h2 className="card-title display">继续写</h2>
              </div>
              <button type="button" className="card-link" onClick={() => setView("notes")}>
                全部 <ArrowUpRight size={14} />
              </button>
            </div>

            <div className="recent-notes">
              {recentNotes.length === 0 ? (
                <div className="recent-notes-empty">
                  <FileText size={18} />
                  <p>还没有笔记。</p>
                </div>
              ) : (
                recentNotes.map((note: Note) => (
                  <button key={note.id} type="button" className="recent-note" onClick={() => openNote(note.id)}>
                    <div className="recent-note-top">
                      <span>{updatedLabel(note.updatedAt)}</span>
                      {note.tags[0] && <span className="recent-note-tag">#{note.tags[0]}</span>}
                    </div>
                    <h3>{noteTitle(note.title)}</h3>
                    <p>{excerpt(note.content, isMobile ? 80 : 100) || "空白笔记"}</p>
                    <span className="recent-note-arrow">
                      <ChevronRight size={14} />
                    </span>
                  </button>
                ))
              )}
            </div>

            <button
              type="button"
              className="new-note-inline"
              onClick={async () => {
                const note = await createNote();
                openNote(note.id);
              }}
            >
              <span className="new-note-inline-icon">
                <Plus size={15} />
              </span>
              写点什么
              <span className="new-note-inline-hint">⌘ N</span>
            </button>
          </section>
        </div>

        <section className={cn("ai-brief-card", briefBusy && "is-generating")}>
          <div className="ai-brief-art" aria-hidden="true">
            <div className="ai-brief-orb">
              <Sparkles size={23} />
            </div>
            <span className="ai-brief-line ai-brief-line-1" />
            <span className="ai-brief-line ai-brief-line-2" />
            <span className="ai-brief-star">✦</span>
          </div>
          <div className="ai-brief-body">
            <div className="ai-brief-kicker">
              <span className="eyebrow">Lafei AI</span>
              <span className="ai-brief-badge">每日简报</span>
            </div>
            {brief || briefBusy ? (
              <>
                <div className="ai-brief-text">
                  {brief ? (
                    brief.split(/\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)
                  ) : (
                    <span className="ai-brief-thinking">
                      <span />
                      <span />
                      <span />
                    </span>
                  )}
                </div>
                {briefError && <p className="ai-brief-error">{briefError}</p>}
                <div className="ai-brief-actions">
                  {briefBusy ? (
                    <button type="button" className="btn btn-sm btn-outline" onClick={stopBrief}>
                      <Square size={12} /> 停止
                    </button>
                  ) : (
                    <>
                      {brief && (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => void saveBriefAsNote()}>
                          <FileText size={13} /> 存为今日笔记
                        </button>
                      )}
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void generateBrief()}>
                        <Sparkles size={13} /> 重新生成
                      </button>
                      {briefError && (
                        <button type="button" className="btn btn-sm btn-outline" onClick={() => setSettingsOpen(true)}>
                          检查 AI 设置
                        </button>
                      )}
                    </>
                  )}
                </div>
              </>
            ) : (
              <>
                <h2 className="ai-brief-title display">
                  今天，先做<span>哪一件</span>？
                </h2>
                <p className="ai-brief-local">{localBrief}</p>
                <div className="ai-brief-actions">
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => void generateBrief()}>
                    <Sparkles size={13} /> {isAIConfigured(ai) ? "让 AI 深读今天" : "配置 AI，生成简报"}
                  </button>
                  {!isAIConfigured(ai) && (
                    <span className="ai-brief-config-hint">只需一个 API Key，数据仍留在本地</span>
                  )}
                  {briefError && <span className="ai-brief-error">{briefError}</span>}
                </div>
              </>
            )}
          </div>
          <button type="button" className="ai-brief-side-link" onClick={() => setView("assistant")}>
            打开 AI 助手 <ArrowRight size={13} />
          </button>
        </section>

        <footer className="today-footer">
          <span className="today-footer-mark">lafei.</span>
          <span>把知识收好，把行动理清。</span>
          <span className="today-footer-spacer" />
          <span>{notes.length} 篇笔记 · {tasks.filter((task) => !task.done).length} 个未完成</span>
        </footer>
      </div>
    </div>
  );
}
