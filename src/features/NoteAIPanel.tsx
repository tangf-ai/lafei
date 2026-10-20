import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  Copy,
  Heading2,
  ListChecks,
  Loader2,
  PenLine,
  RotateCcw,
  Send,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type { Note } from "../types";
import {
  AIError,
  EXTRACT_PROMPT,
  buildNoteActionPrompt,
  completeChat,
  isAIConfigured,
  localChecklistTasks,
  notePrompt,
  parseExtractedTasks,
  streamChat,
  type ExtractedTask,
  type NoteActionId,
} from "../lib/ai";
import { useUI, toast } from "../store/ui";
import { Markdown } from "../lib/markdown";
import { cn, dueLabel, newId, noteTitle } from "../lib/util";
import { createTask } from "../db";

interface Turn {
  id: string;
  label: string;
  question?: string;
  content: string;
  status: "streaming" | "done" | "error";
  error?: string;
  mode: "text" | "tasks" | "titles";
  tasks?: ExtractedTask[];
}

const ACTION_META: Array<{
  id: NoteActionId;
  icon: typeof Sparkles;
  description: string;
}> = [
  { id: "summarize", icon: Sparkles, description: "一句话核心 + 三个要点" },
  { id: "extract", icon: ListChecks, description: "把下一步变成可执行任务" },
  { id: "continue", icon: PenLine, description: "顺着当前的思路写下一段" },
  { id: "title", icon: Heading2, description: "从内容里提炼五个标题" },
];

interface Props {
  note: Note;
  onClose: () => void;
  onAppend: (text: string) => void;
  onSetTitle: (title: string) => void;
  getSelection: () => string;
}

export function NoteAIPanel({ note, onClose, onAppend, onSetTitle, getSelection }: Props) {
  const ai = useUI((state) => state.ai);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const configured = isAIConfigured(ai);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: turns.some((turn) => turn.status === "streaming") ? "auto" : "smooth" });
  }, [turns]);

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setTurns((current) =>
      current.map((turn) =>
        turn.status === "streaming"
          ? { ...turn, status: turn.content.trim() ? "done" : "error", error: turn.content.trim() ? undefined : "已停止生成。" }
          : turn,
      ),
    );
  };

  const runStream = async (label: string, prompt: string, question?: string) => {
    if (busy) return;
    const id = newId();
    setTurns((current) => [
      ...current,
      { id, label, question, content: "", status: "streaming", mode: "text" },
    ]);
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat({
        settings: ai,
        messages: [
          {
            role: "system",
            content:
              "你是 Lafei 的笔记 AI。你在帮助用户处理一篇中文笔记。直接给出结果，不解释你的过程，不说“好的”。用简洁、自然的简体中文，允许使用 Markdown。",
          },
          { role: "user", content: prompt },
        ],
        signal: controller.signal,
        maxTokens: 1200,
        onDelta: (delta) => {
          setTurns((current) =>
            current.map((turn) => (turn.id === id ? { ...turn, content: turn.content + delta } : turn)),
          );
        },
      });
      setTurns((current) =>
        current.map((turn) => (turn.id === id ? { ...turn, status: "done" } : turn)),
      );
    } catch (error) {
      if ((error as Error).name === "AbortError") return;
      const message = error instanceof AIError ? error.message : "生成时出了点问题，请稍后再试。";
      setTurns((current) =>
        current.map((turn) =>
          turn.id === id ? { ...turn, status: "error", error: message } : turn,
        ),
      );
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  };

  const runAction = async (action: NoteActionId) => {
    if (!configured || busy) return;
    if (action === "extract") {
      const id = newId();
      setTurns((current) => [
        ...current,
        { id, label: "提取待办", content: "正在读完这篇笔记，找出可以行动的部分…", status: "streaming", mode: "text" },
      ]);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const raw = await completeChat({
          settings: ai,
          messages: [
            { role: "system", content: "你是一个严谨的任务提取助手，只输出 JSON。" },
            { role: "user", content: `${notePrompt(note)}\n\n${EXTRACT_PROMPT}` },
          ],
          signal: controller.signal,
          maxTokens: 1000,
          temperature: 0.2,
        });
        const tasks = parseExtractedTasks(raw);
        if (tasks.length === 0) {
          const local = localChecklistTasks(note.content);
          if (local.length) {
            setTurns((current) =>
              current.map((turn) =>
                turn.id === id
                  ? {
                      ...turn,
                      label: "提取待办 · 本地规则",
                      content: "没有调用成功，先用复选框帮你找出了这些：",
                      status: "done",
                      mode: "tasks",
                      tasks: local,
                    }
                  : turn,
              ),
            );
          } else {
            setTurns((current) =>
              current.map((turn) =>
                turn.id === id
                  ? {
                      ...turn,
                      content: "这篇笔记里没有找到足够明确、可执行的下一步。试试把想法写成「- [ ] 具体动作」，或用提问的方式让我帮你拆解。",
                      status: "done",
                      mode: "text",
                    }
                  : turn,
              ),
            );
          }
        } else {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === id ? { ...turn, content: "", status: "done", mode: "tasks", tasks } : turn,
            ),
          );
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          const message = error instanceof AIError ? error.message : "提取待办时出了点问题。";
          setTurns((current) =>
            current.map((turn) => (turn.id === id ? { ...turn, status: "error", error: message } : turn)),
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
        }
      }
      return;
    }

    if (action === "title") {
      const id = newId();
      setTurns((current) => [
        ...current,
        { id, label: "起标题", content: "正在寻找几个合适的角度…", status: "streaming", mode: "text" },
      ]);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const raw = await completeChat({
          settings: ai,
          messages: [
            { role: "system", content: "你是一个擅长取标题的中文编辑。只输出标题本身。" },
            { role: "user", content: buildNoteActionPrompt("title", note) },
          ],
          signal: controller.signal,
          maxTokens: 300,
          temperature: 0.8,
        });
        setTurns((current) =>
          current.map((turn) =>
            turn.id === id ? { ...turn, content: raw.trim(), status: "done", mode: "titles" } : turn,
          ),
        );
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          const message = error instanceof AIError ? error.message : "想标题时出了点问题。";
          setTurns((current) =>
            current.map((turn) => (turn.id === id ? { ...turn, status: "error", error: message } : turn)),
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setBusy(false);
        }
      }
      return;
    }

    const label = action === "summarize" ? "总结这篇" : "接着写";
    await runStream(label, buildNoteActionPrompt(action, note));
  };

  const ask = async () => {
    const question = input.trim();
    if (!question || busy || !configured) return;
    setInput("");
    const selection = getSelection().trim();
    const reference = selection
      ? `\n\n用户当前选中的笔记片段：\n"""\n${selection.slice(0, 4000)}\n"""`
      : "";
    await runStream(
      "你在问",
      `${notePrompt(note)}${reference}\n\n用户的问题：${question}\n\n请基于这篇笔记回答。如果笔记信息不足，直接说明，并给出你认为最合理的追问或建议。`,
      question,
    );
  };

  const localExtract = () => {
    const tasks = localChecklistTasks(note.content);
    if (!tasks.length) {
      toast("笔记里没有复选框格式的待办");
      return;
    }
    setTurns([
      {
        id: newId(),
        label: "提取待办 · 本地",
        content: "",
        status: "done",
        mode: "tasks",
        tasks,
      },
    ]);
  };

  return (
    <aside className="note-ai-panel" aria-label="笔记 AI 面板">
      <header className="ai-panel-head">
        <div className="ai-panel-heading">
          <span className="ai-orb">
            <Sparkles size={15} />
          </span>
          <div>
            <strong>笔记 AI</strong>
            <span>{noteTitle(note.title)}</span>
          </div>
        </div>
        <div className="ai-panel-head-actions">
          {turns.length > 0 && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              title="清空对话"
              onClick={() => {
                stop();
                setTurns([]);
              }}
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button type="button" className="icon-btn icon-btn-sm" onClick={onClose} aria-label="关闭 AI 面板">
            <X size={16} />
          </button>
        </div>
      </header>

      <div className="ai-panel-scroll" ref={scrollRef}>
        {!configured ? (
          <div className="ai-setup">
            <div className="ai-setup-art">
              <span className="ai-orb ai-orb-lg">
                <Sparkles size={24} />
              </span>
              <span className="ai-setup-ring" />
            </div>
            <h3 className="display">让 AI 读懂这一页</h3>
            <p>
              配置任意 OpenAI 兼容接口后，AI 可以总结笔记、提取待办、接着写，甚至替你想几个标题。API Key
              只保存在当前设备。
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={15} /> 配置 AI
            </button>
            <div className="ai-setup-divider">
              <span>或者</span>
            </div>
            <button type="button" className="btn btn-outline" onClick={localExtract}>
              <ListChecks size={15} /> 从复选框提取待办
            </button>
            <p className="ai-setup-hint">不需要 AI，也能识别 <code>- [ ]</code> 格式的清单。</p>
          </div>
        ) : turns.length === 0 ? (
          <div className="ai-intro">
            <div className="ai-intro-head">
              <span className="ai-intro-kicker">
                <span className="local-dot" /> 已读取当前笔记
              </span>
              <h3 className="display">
                这一页，
                <br />
                想怎么继续？
              </h3>
            </div>
            <div className="ai-action-grid">
              {ACTION_META.map(({ id, icon: Icon, description }) => (
                <button key={id} type="button" className="ai-action-card" onClick={() => void runAction(id)}>
                  <span className="ai-action-icon">
                    <Icon size={16} />
                  </span>
                  <span>
                    <strong>{id === "extract" ? "提取待办" : id === "summarize" ? "总结这篇" : id === "continue" ? "接着写" : "起个标题"}</strong>
                    <em>{description}</em>
                  </span>
                </button>
              ))}
            </div>
            <p className="ai-intro-tip">
              也可以在下面直接提问。选中正文里的某一段，提问时我会把它一起带上。
            </p>
          </div>
        ) : (
          <div className="ai-turns">
            {turns.map((turn) => (
              <div className="ai-turn" key={turn.id}>
                <div className="ai-turn-label">
                  <span className="ai-turn-dot" />
                  {turn.label}
                </div>
                {turn.question && <div className="ai-question">{turn.question}</div>}
                {turn.mode === "tasks" && turn.tasks ? (
                  <ExtractedTasks
                    tasks={turn.tasks}
                    noteId={note.id}
                    onAdded={(count) => toast(`已添加 ${count} 个任务`, "success")}
                  />
                ) : turn.mode === "titles" && turn.status === "done" ? (
                  <TitleSuggestions
                    raw={turn.content}
                    current={note.title}
                    onPick={(title) => {
                      onSetTitle(title);
                      toast("标题已更新", "success");
                    }}
                  />
                ) : (
                  <>
                    <div className={cn("ai-answer", turn.status === "error" && "has-error")}>
                      {turn.content ? (
                        <Markdown content={turn.content} className="prose-compact" />
                      ) : turn.status === "streaming" ? (
                        <div className="ai-thinking">
                          <span />
                          <span />
                          <span />
                        </div>
                      ) : null}
                      {turn.status === "streaming" && turn.content && <span className="ai-caret" />}
                    </div>
                    {turn.error && (
                      <div className="ai-error">
                        <AlertCircle size={14} />
                        <span>{turn.error}</span>
                        {turn.error.includes("配置") && (
                          <button type="button" onClick={() => setSettingsOpen(true)}>
                            去设置 <Settings2 size={11} />
                          </button>
                        )}
                      </div>
                    )}
                    {turn.status === "done" && turn.content && (
                      <div className="ai-turn-actions">
                        <CopyButton text={turn.content} />
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onAppend(turn.content)}>
                          <ArrowDownToLine size={13} /> 追加到笔记
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            {busy && (
              <div className="ai-stop-row">
                <span className="ai-generating">
                  <Loader2 size={13} className="spin" /> 正在生成
                </span>
                <button type="button" className="btn btn-sm btn-outline" onClick={stop}>
                  <Square size={11} /> 停止
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {configured && (
        <div className="ai-composer">
          <div className="ai-composer-box">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="针对这篇笔记提问…"
              rows={2}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void ask();
                }
              }}
            />
            <div className="ai-composer-foot">
              <span className="ai-context-chip">
                <span className="local-dot" /> 已附带当前笔记
              </span>
              <button
                type="button"
                className="ai-send-btn"
                disabled={!input.trim() || busy}
                onClick={() => void ask()}
                aria-label="发送"
              >
                {busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
              </button>
            </div>
          </div>
          <p className="ai-composer-hint">Enter 发送 · Shift + Enter 换行 · AI 也会犯错，请核对重要内容</p>
        </div>
      )}
    </aside>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "已复制" : "复制"}
    </button>
  );
}

function ExtractedTasks({
  tasks,
  noteId,
  onAdded,
}: {
  tasks: ExtractedTask[];
  noteId: string;
  onAdded: (count: number) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set(tasks.map((_, index) => index)));
  const [added, setAdded] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggle = (index: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const add = async () => {
    if (saving) return;
    setSaving(true);
    const chosen = tasks.filter((_, index) => selected.has(index));
    await Promise.all(
      chosen.map((task) =>
        createTask({
          title: task.title,
          noteId,
          dueDate: task.dueDate,
          priority: task.priority,
        }),
      ),
    );
    setSaving(false);
    setAdded(true);
    onAdded(chosen.length);
  };

  return (
    <div className="ai-task-list">
      {tasks.map((task, index) => (
        <label key={`${task.title}-${index}`} className={cn("ai-task-item", added && "is-added")}>
          <button
            type="button"
            className={cn("task-check", selected.has(index) && "is-done")}
            onClick={() => !added && toggle(index)}
            aria-label={selected.has(index) ? "取消选择" : "选择"}
          >
            {selected.has(index) && <Check size={11} strokeWidth={3} />}
          </button>
          <span className="ai-task-text">
            <span>{task.title}</span>
            <span className="ai-task-meta">
              <span className={`priority-dot priority-${task.priority}`} />
              {task.priority === "high" ? "高优先级" : task.priority === "low" ? "低优先级" : "中优先级"}
              {task.dueDate && <> · {dueLabel(task.dueDate).label}</>}
            </span>
          </span>
        </label>
      ))}
      <button
        type="button"
        className="btn btn-primary btn-sm ai-task-add"
        disabled={added || saving || selected.size === 0}
        onClick={() => void add()}
      >
        {added ? (
          <>
            <Check size={13} /> 已加入任务
          </>
        ) : saving ? (
          <>
            <Loader2 size={13} className="spin" /> 添加中…
          </>
        ) : (
          <>
            <ListChecks size={13} /> 添加 {selected.size} 个任务
          </>
        )}
      </button>
    </div>
  );
}

function TitleSuggestions({ raw, current, onPick }: { raw: string; current: string; onPick: (title: string) => void }) {
  const titles = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.、)\s]+/, "").replace(/^["“「]|["”」]$/g, "").trim())
    .filter((line) => line && line.length <= 30)
    .slice(0, 6);
  if (!titles.length) return <Markdown content={raw} className="prose-compact" />;
  return (
    <div className="ai-title-list">
      {titles.map((title) => (
        <button key={title} type="button" className="ai-title-option" onClick={() => onPick(title)}>
          <span>{title}</span>
          {title.trim() === current.trim() ? <Check size={14} /> : <span className="ai-title-use">设为标题</span>}
        </button>
      ))}
    </div>
  );
}
