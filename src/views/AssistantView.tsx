import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  BookOpen,
  CalendarCheck,
  Check,
  Compass,
  Copy,
  FileText,
  History,
  ListChecks,
  MessageSquare,
  NotebookPen,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { db, createNote, deleteChatCascade } from "../db";
import { useUI, toast } from "../store/ui";
import {
  AIError,
  buildChatMessages,
  isAIConfigured,
  retrieveNoteContext,
  streamChat,
} from "../lib/ai";
import type { Chat, ChatMessage, ChatSource } from "../types";
import { Markdown } from "../lib/markdown";
import { tagsOf } from "../lib/tags";
import { cn, dueLabel, newId, updatedLabel } from "../lib/util";
import { Modal } from "../components/Modal";

interface StreamingReply {
  chatId: string;
  content: string;
  sources: ChatSource[];
}

const SUGGESTIONS = [
  {
    icon: CalendarCheck,
    title: "帮我规划今天",
    description: "看看今天的任务，挑出最重要的一件",
    prompt: "帮我规划今天。先看看我今天的任务和最近的笔记，告诉我最该先做什么，以及为什么。",
  },
  {
    icon: Compass,
    title: "我最近在想什么？",
    description: "从最近的笔记里，找反复出现的线索",
    prompt: "翻翻我最近的笔记，帮我总结一下我最近在思考什么。哪些想法反复出现？哪些值得继续推进？",
  },
  {
    icon: NotebookPen,
    title: "把零散的想法整理成笔记",
    description: "给还没成形的念头一个结构",
    prompt: "我想把最近零散的想法整理成一篇结构清晰的笔记。先帮我看看素材里有什么，再给出一个提纲。",
  },
  {
    icon: ListChecks,
    title: "从笔记里找下一步",
    description: "把停留在纸上的想法变成行动",
    prompt: "从我的笔记里找出那些已经可以行动、但还没变成任务的下一步。只挑真正重要的，最多 5 个。",
  },
];

export function AssistantView() {
  const chats = useLiveQuery(() => db.chats.orderBy("updatedAt").reverse().toArray(), [], []);
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const ai = useUI((state) => state.ai);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const openNote = useUI((state) => state.openNote);
  const configured = isAIConfigured(ai);

  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [useNotes, setUseNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState<StreamingReply | null>(null);
  const [error, setError] = useState("");
  const [pendingUser, setPendingUser] = useState<ChatMessage | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initializedRef = useRef(false);

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const messages = useLiveQuery(
    () =>
      activeChatId
        ? db.messages.where("chatId").equals(activeChatId).toArray().then((items) => items.sort((a, b) => a.createdAt - b.createdAt))
        : Promise.resolve([] as ChatMessage[]),
    [activeChatId],
    [],
  );

  const displayMessages = useMemo(() => {
    const base = [...messages];
    if (pendingUser && !base.some((message) => message.id === pendingUser.id)) base.push(pendingUser);
    return base.sort((a, b) => a.createdAt - b.createdAt);
  }, [messages, pendingUser]);

  useEffect(() => {
    if (!initializedRef.current && chats.length > 0) {
      initializedRef.current = true;
      setActiveChatId(chats[0].id);
    }
  }, [chats]);

  useEffect(() => {
    if (pendingUser && messages.some((message) => message.id === pendingUser.id)) {
      setPendingUser(null);
    }
  }, [messages, pendingUser]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: busy ? "auto" : "smooth" });
  }, [displayMessages.length, streaming?.content, busy, activeChatId]);

  useEffect(() => {
    if (!textareaRef.current) return;
    const el = textareaRef.current;
    // 输入框至少保持两行高度，内容变多时再向上长
    const minHeight = 52;
    el.style.height = "auto";
    el.style.height = `${Math.max(minHeight, Math.min(150, el.scrollHeight))}px`;
  }, [input]);

  const chatTitle = (prompt: string) => {
    const cleaned = prompt.replace(/\s+/g, " ").trim();
    return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned;
  };

  const saveAssistantMessage = async (chatId: string, content: string, sources: ChatSource[]) => {
    const message: ChatMessage = {
      id: newId(),
      chatId,
      role: "assistant",
      content,
      sources,
      createdAt: Date.now(),
    };
    await db.messages.add(message);
    await db.chats.update(chatId, { updatedAt: Date.now() });
  };

  const stop = (silent = false) => {
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setBusy(false);
    if (!silent) toast("已停止生成");
  };

  const send = async (override?: string) => {
    const question = (override ?? input).trim();
    if (!question || busyRef.current) return;
    if (!configured) {
      setSettingsOpen(true);
      return;
    }

    busyRef.current = true;
    setInput("");
    setError("");
    setBusy(true);

    let chatId = activeChatId;
    let chat = activeChat;
    if (!chatId || !chat) {
      const now = Date.now();
      chat = {
        id: newId(),
        title: chatTitle(question),
        createdAt: now,
        updatedAt: now,
      };
      await db.chats.add(chat);
      chatId = chat.id;
      setActiveChatId(chat.id);
    } else {
      await db.chats.update(chat.id, { updatedAt: Date.now() });
    }
    initializedRef.current = true;

    const retrieved = useNotes ? retrieveNoteContext(notes, question) : null;
    const sources = retrieved?.sources ?? [];
    const context = retrieved;
    const history = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-14)
      .map((message) => ({ role: message.role, content: message.content }) as const);

    const openTasks = tasks.filter((task) => !task.done).slice(0, 12);
    const taskBlock = openTasks.length
      ? `\n\n用户当前的未完成任务：\n${openTasks
          .map((task) => {
            const tags = tagsOf(task);
            return `- [ ] ${task.title}${tags.length ? ` #${tags.join(" #")}` : ""}${task.dueDate ? `（${dueLabel(task.dueDate).label}）` : ""}${task.priority === "high" ? "（高优先级）" : ""}`;
          })
          .join("\n")}`
      : "";
    const built = buildChatMessages(history, question, context);
    built[0] = { ...built[0], content: `${built[0].content}${taskBlock}` };

    const userMessage: ChatMessage = {
      id: newId(),
      chatId,
      role: "user",
      content: question,
      sources: [],
      createdAt: Date.now(),
    };
    setPendingUser(userMessage);
    await db.messages.add(userMessage);

    const controller = new AbortController();
    abortRef.current = controller;
    let full = "";
    setStreaming({ chatId, content: "", sources });

    try {
      full = await streamChat({
        settings: ai,
        messages: built,
        signal: controller.signal,
        maxTokens: 1600,
        onDelta: (delta) => {
          full += delta;
          setStreaming((current) =>
            current && current.chatId === chatId ? { ...current, content: current.content + delta } : current,
          );
        },
      });
      await saveAssistantMessage(chatId, full, sources);
      setStreaming(null);
      setError("");
    } catch (reason) {
      if ((reason as Error).name === "AbortError") {
        if (full.trim()) {
          await saveAssistantMessage(chatId, full, sources);
        }
        setStreaming(null);
      } else {
        const message = reason instanceof AIError ? reason.message : "出了点问题，请稍后再试。";
        setError(message);
        setStreaming(null);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const newChat = () => {
    stop(true);
    setActiveChatId(null);
    setStreaming(null);
    setPendingUser(null);
    setError("");
    setHistoryOpen(false);
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  };

  const selectChat = (id: string) => {
    if (id === activeChatId) {
      setHistoryOpen(false);
      return;
    }
    stop(true);
    setActiveChatId(id);
    setStreaming(null);
    setPendingUser(null);
    setError("");
    setHistoryOpen(false);
  };

  const deleteChat = async (chat: Chat) => {
    if (chat.id === activeChatId) {
      stop(true);
      setActiveChatId(null);
      setStreaming(null);
      setPendingUser(null);
    }
    await deleteChatCascade(chat.id);
    toast("对话已删除");
  };

  const copyMessage = async (message: ChatMessage) => {
    await navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId(null), 1600);
  };

  const saveAsNote = async (message: ChatMessage) => {
    const firstLine = message.content.split("\n").find((line) => line.trim()) ?? "AI 对话";
    const cleaned = firstLine.replace(/[#*`>]/g, "").trim().slice(0, 40) || "AI 对话";
    const chatMessages = displayMessages.slice(-4);
    const context = chatMessages.some((item) => item.role === "user")
      ? `\n\n---\n\n> 对话来源：${activeChat?.title ?? "AI 助手"}`
      : "";
    const note = await createNote({
      title: cleaned,
      content: message.content + context,
      tags: ["AI"],
    });
    openNote(note.id);
    toast("已保存为笔记", "success");
  };

  const historyList = (
    <div className="chat-history-list">
      {chats.length === 0 ? (
        <div className="chat-history-empty">
          <MessageSquare size={18} />
          <p>还没有对话。</p>
          <span>问出第一个问题后，它会保存在这里。</span>
        </div>
      ) : (
        chats.map((chat) => (
          <div
            key={chat.id}
            className={cn("chat-history-item", activeChatId === chat.id && "is-active")}
            role="button"
            tabIndex={0}
            onClick={() => selectChat(chat.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") selectChat(chat.id);
            }}
          >
            <MessageSquare size={14} />
            <div className="chat-history-item-text">
              <strong>{chat.title}</strong>
              <span>{updatedLabel(chat.updatedAt)}</span>
            </div>
            <button
              type="button"
              className="chat-history-delete"
              aria-label="删除对话"
              onClick={(event) => {
                event.stopPropagation();
                void deleteChat(chat);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))
      )}
    </div>
  );

  const showWelcome = displayMessages.length === 0 && !streaming;

  return (
    <div className="assistant-layout" data-tauri-drag-region>
      <aside className="assistant-sidebar">
        <div className="assistant-side-head">
          <span className="eyebrow">Conversations</span>
          <button type="button" className="icon-btn icon-btn-sm" onClick={newChat} title="新对话">
            <Plus size={16} />
          </button>
        </div>
        {historyList}
        <div className="assistant-side-foot">
          <span className="local-dot" />
          <span>对话仅保存在本机</span>
        </div>
      </aside>

      <section className="assistant-main">
        <header className="assistant-topbar" data-tauri-drag-region>
          <div className="assistant-title-wrap">
            <span className="assistant-orb">
              <Sparkles size={16} />
            </span>
            <div>
              <strong>AI 助手</strong>
              <span>会引用你的笔记</span>
            </div>
          </div>
          <div className="assistant-topbar-actions">
            <button type="button" className="icon-btn assistant-history-mobile" onClick={() => setHistoryOpen(true)} title="历史对话">
              <History size={18} />
            </button>
            <button type="button" className="btn btn-sm btn-outline assistant-new-chat" onClick={newChat}>
              <Plus size={14} /> <span className="assistant-new-chat-label">新对话</span>
            </button>
          </div>
        </header>

        <div className="assistant-body">
          <div className="assistant-scroll" ref={messagesRef}>
            {showWelcome ? (
              <div className="assistant-welcome">
                <div className="assistant-hero-mark" aria-hidden="true">
                  <Sparkles size={22} />
                </div>
                <span className="eyebrow">Your second mind</span>
                <h1 className="assistant-hero-title display">
                  问我任何事，
                  <br />
                  <em>包括你写过的东西。</em>
                </h1>
                <p className="assistant-hero-sub">
                  {notes.length > 0
                    ? `我会先在你 ${notes.length} 篇笔记里找一找，再结合今天的任务回答。`
                    : "你的笔记会成为我的上下文。写下第一篇后，我会记得你在想什么。"}
                </p>

                <div className="assistant-suggestions">
                  {SUGGESTIONS.map((suggestion) => {
                    const Icon = suggestion.icon;
                    return (
                      <button
                        key={suggestion.title}
                        type="button"
                        className="assistant-suggestion"
                        onClick={() => {
                          if (!configured) {
                            setSettingsOpen(true);
                            return;
                          }
                          void send(suggestion.prompt);
                        }}
                      >
                        <span className="assistant-suggestion-icon">
                          <Icon size={16} />
                        </span>
                        <span>
                          <strong>{suggestion.title}</strong>
                          <em>{suggestion.description}</em>
                        </span>
                        <span className="assistant-suggestion-arrow">↗</span>
                      </button>
                    );
                  })}
                </div>

                <div className="assistant-capabilities">
                  <span>
                    <BookOpen size={13} /> 检索你的笔记
                  </span>
                  <span>
                    <ListChecks size={13} /> 结合今日任务
                  </span>
                  <span>
                    <FileText size={13} /> 答案可存为笔记
                  </span>
                </div>
              </div>
            ) : (
              <div className="assistant-messages">
                {displayMessages.map((message) =>
                  message.role === "user" ? (
                    <div className="chat-user-row" key={message.id}>
                      <div className="chat-user-bubble">{message.content}</div>
                      <span className="chat-time">{formatTime(message.createdAt)}</span>
                    </div>
                  ) : (
                    <div className="chat-ai-row" key={message.id}>
                      <div className="chat-ai-avatar">
                        <Sparkles size={14} />
                      </div>
                      <div className="chat-ai-content">
                        <div className="chat-ai-head">
                          <strong>Lafei</strong>
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <Markdown content={message.content} className="prose-chat" />
                        {message.sources.length > 0 && (
                          <div className="chat-sources">
                            <span className="chat-sources-label">参考了</span>
                            {message.sources.map((source) => (
                              <button
                                key={source.id}
                                type="button"
                                className="chat-source"
                                onClick={() => openNote(source.id)}
                              >
                                <FileText size={11} /> {source.title}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="chat-ai-actions">
                          <button type="button" onClick={() => void copyMessage(message)}>
                            {copiedId === message.id ? <Check size={13} /> : <Copy size={13} />}
                            {copiedId === message.id ? "已复制" : "复制"}
                          </button>
                          <button type="button" onClick={() => void saveAsNote(message)}>
                            <FileText size={13} /> 存为笔记
                          </button>
                        </div>
                      </div>
                    </div>
                  ),
                )}

                {streaming && (
                  <div className="chat-ai-row is-streaming">
                    <div className="chat-ai-avatar">
                      <Sparkles size={14} />
                    </div>
                    <div className="chat-ai-content">
                      <div className="chat-ai-head">
                        <strong>Lafei</strong>
                        <span className="chat-thinking-label">正在思考</span>
                      </div>
                      {streaming.content ? (
                        <>
                          <Markdown content={streaming.content} className="prose-chat" />
                          <span className="ai-caret" />
                        </>
                      ) : (
                        <div className="ai-thinking">
                          <span />
                          <span />
                          <span />
                        </div>
                      )}
                      {streaming.sources.length > 0 && (
                        <div className="chat-sources">
                          <span className="chat-sources-label">正在参考</span>
                          {streaming.sources.map((source) => (
                            <span className="chat-source" key={source.id}>
                              <FileText size={11} /> {source.title}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="assistant-error">
                    <span>{error}</span>
                    <button type="button" onClick={() => setSettingsOpen(true)}>
                      检查设置 <Settings2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="assistant-composer-wrap">
            {!configured && (
              <div className="assistant-setup-banner">
                <span className="assistant-setup-icon">
                  <Sparkles size={15} />
                </span>
                <div>
                  <strong>先接入一个 AI 模型</strong>
                  <span>支持 DeepSeek、OpenAI 或任何 OpenAI 兼容接口，Key 只保存在本机。</span>
                </div>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setSettingsOpen(true)}>
                  去配置
                </button>
              </div>
            )}
            <div className="assistant-composer">
              <textarea
                ref={textareaRef}
                value={input}
                rows={2}
                placeholder={configured ? "问点什么，或让 AI 帮你整理…" : "配置 AI 后开始对话…"}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                aria-label="向 AI 提问"
              />
              <div className="assistant-composer-bar">
                <button
                  type="button"
                  className={cn("context-toggle", useNotes && "is-on")}
                  onClick={() => setUseNotes((value) => !value)}
                  title={useNotes ? "已开启笔记检索，点击关闭" : "开启笔记检索"}
                >
                  <BookOpen size={13} />
                  引用笔记
                  {useNotes && notes.length > 0 && <span>{notes.length}</span>}
                </button>
                <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
                {busy ? (
                  <button type="button" className="assistant-send is-stop" onClick={() => stop()} aria-label="停止生成">
                    <Square size={14} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="assistant-send"
                    disabled={!input.trim()}
                    onClick={() => void send()}
                    aria-label="发送"
                  >
                    <Send size={16} />
                  </button>
                )}
              </div>
            </div>
            <p className="assistant-disclaimer">AI 也会犯错。重要的事实和日期，请自己核对。</p>
          </div>
        </div>
      </section>

      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        headless
        size="sm"
        className="chat-history-modal"
      >
        <div className="chat-history-modal-head">
          <div>
            <span className="eyebrow">Conversations</span>
            <h2 className="display">历史对话</h2>
          </div>
          <button type="button" className="icon-btn" onClick={() => setHistoryOpen(false)} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="chat-history-modal-actions">
          <button type="button" className="btn btn-sm btn-primary" onClick={newChat}>
            <Plus size={14} /> 新对话
          </button>
        </div>
        {historyList}
      </Modal>
    </div>
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
