import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowUpRight,
  BookOpen,
  CalendarCheck,
  Check,
  Compass,
  Copy,
  FileText,
  ListChecks,
  Maximize2,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { db } from "../db";
import { useUI } from "../store/ui";
import { useAssistantChat, useAssistantMessages } from "../store/assistant";
import { isAIConfigured } from "../lib/ai";
import { Markdown } from "../lib/markdown";
import { useIsMobile } from "../lib/hooks";
import { cn } from "../lib/util";
import type { ChatMessage } from "../types";

/**
 * 右下角的快速对话浮窗。
 *
 * - 没打开时只有一个圆形悬浮按钮（FAB），流式生成中会在按钮右上角亮一个脉冲点；
 * - 打开后是固定在右下角的紧凑面板，与完整 AI 助手页共用 src/store/assistant.ts 的
 *   同一个对话、同一段流式输出，所以在浮窗里问一半可以收起，去完整助手页接着看；
 * - 不是模态：没有遮罩、不锁 body 滚动、点面板外面不关闭，收起靠 × / Esc / ⌘J。
 */

const SUGGESTIONS = [
  {
    icon: CalendarCheck,
    title: "帮我规划今天",
    prompt: "帮我规划今天。先看看我今天的任务和最近的笔记，告诉我最该先做什么，以及为什么。",
  },
  {
    icon: Compass,
    title: "我最近在想什么？",
    prompt: "翻翻我最近的笔记，帮我总结一下我最近在思考什么。哪些想法反复出现？哪些值得继续推进？",
  },
  {
    icon: ListChecks,
    title: "从笔记里找下一步",
    prompt: "从我的笔记里找出那些已经可以行动、但还没变成任务的下一步。只挑真正重要的，最多 5 个。",
  },
];

/** 输入框至少两行，最高约四行 */
const TEXTAREA_MIN = 46;
const TEXTAREA_MAX = 96;

export function QuickAssistant() {
  const open = useUI((state) => state.quickAssistantOpen);
  const setOpen = useUI((state) => state.setQuickAssistantOpen);
  const view = useUI((state) => state.view);
  const activeNoteId = useUI((state) => state.activeNoteId);
  const setView = useUI((state) => state.setView);
  const openNote = useUI((state) => state.openNote);
  const ai = useUI((state) => state.ai);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  const isMobile = useIsMobile();
  const configured = isAIConfigured(ai);

  const chats = useLiveQuery(() => db.chats.orderBy("updatedAt").reverse().toArray(), [], []);
  const notesCount = useLiveQuery(() => db.notes.count(), [], 0);

  const activeChatId = useAssistantChat((state) => state.activeChatId);
  const busy = useAssistantChat((state) => state.busy);
  const streaming = useAssistantChat((state) => state.streaming);
  const pendingUser = useAssistantChat((state) => state.pendingUser);
  const error = useAssistantChat((state) => state.error);
  const useNotes = useAssistantChat((state) => state.useNotes);
  const initChat = useAssistantChat((state) => state.initChat);
  const startNewChat = useAssistantChat((state) => state.startNewChat);
  const toggleUseNotes = useAssistantChat((state) => state.toggleUseNotes);
  const send = useAssistantChat((state) => state.send);
  const stop = useAssistantChat((state) => state.stop);
  const saveAsNote = useAssistantChat((state) => state.saveAsNote);

  const messages = useAssistantMessages(activeChatId);

  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  // 已经在完整助手页 / 手机端打开了笔记编辑器时，浮窗没有意义
  const hidden = view === "assistant" || (isMobile && view === "notes" && Boolean(activeNoteId));

  useEffect(() => {
    if (open && hidden) setOpen(false);
  }, [open, hidden, setOpen]);

  // 第一次点开时接着最近一次对话聊；startNewChat() 之后 initialized 已置真，不会再被覆盖
  useEffect(() => {
    if (!open) return;
    initChat(chats[0]?.id ?? null);
  }, [open, chats, initChat]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Esc 收起：弹窗 / 命令面板开着，或编辑器自己处理过按键时让位
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector(".modal-backdrop, .cmdk-backdrop")) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, messages.length, streaming?.content, activeChatId]);

  // 输入框自增高：两行起，最高 96px
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(TEXTAREA_MIN, Math.min(TEXTAREA_MAX, el.scrollHeight))}px`;
  }, [input, open]);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const displayMessages = useMemo(() => {
    const base = [...messages];
    if (pendingUser && !base.some((message) => message.id === pendingUser.id)) base.push(pendingUser);
    return base.sort((a, b) => a.createdAt - b.createdAt);
  }, [messages, pendingUser]);

  const showWelcome = displayMessages.length === 0 && !streaming;
  const showStreaming = Boolean(streaming && streaming.chatId === activeChatId);

  const focusInput = useCallback((delay = 60) => {
    window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), delay);
  }, []);

  const submit = (raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    if (!configured) {
      setSettingsOpen(true);
      return;
    }
    setInput("");
    void send(question);
  };

  const newChat = () => {
    startNewChat();
    setInput("");
    focusInput();
  };

  const openFullAssistant = () => {
    setOpen(false);
    setView("assistant");
  };

  const copyMessage = async (message: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // 剪贴板不可用时静默失败，不打断对话
    }
  };

  // 存为笔记会跳到笔记页，所以存完直接收起浮窗
  const handleSaveAsNote = async (message: ChatMessage) => {
    try {
      await saveAsNote(message);
    } catch (reason) {
      console.error("保存为笔记失败", reason);
    } finally {
      setOpen(false);
    }
  };

  const openSource = (id: string) => {
    openNote(id);
    setOpen(false);
  };

  // 完整助手页 / 手机端笔记编辑器中不出现浮窗任何部件（open 状态由上面的 effect 收起）
  if (hidden) return null;

  const fab = (
    <button
      type="button"
      className="quick-ai-fab"
      title="快速对话（⌘J）"
      aria-label="快速对话"
      onClick={() => setOpen(true)}
    >
      <Sparkles size={20} />
      {busy && <span className="quick-ai-fab-dot" aria-hidden="true" />}
    </button>
  );

  const panel = (
    <section className="quick-ai-panel" role="dialog" aria-label="AI 快速对话">
      <header className="quick-ai-head">
        <span className="quick-ai-mark" aria-hidden="true">
          <Sparkles size={15} />
        </span>
        <div className="quick-ai-head-copy">
          <strong>AI 助手</strong>
          <span>快速对话 · 会引用你的笔记</span>
        </div>
        <div className="quick-ai-head-actions">
          <button type="button" className="quick-ai-icon-btn" onClick={newChat} aria-label="新对话" title="新对话">
            <Plus size={16} />
          </button>
          <button
            type="button"
            className="quick-ai-icon-btn"
            onClick={openFullAssistant}
            aria-label="在完整助手中打开"
            title="在完整助手中打开"
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            className="quick-ai-icon-btn"
            onClick={() => setOpen(false)}
            aria-label="关闭"
            title="关闭（Esc）"
          >
            <X size={16} />
          </button>
        </div>
      </header>

      <div className={cn("quick-ai-body", showWelcome && "is-welcome")} ref={scrollRef}>
        {showWelcome ? (
          <div className="quick-ai-welcome">
            <span className="quick-ai-welcome-mark" aria-hidden="true">
              <Sparkles size={16} />
            </span>
            {configured ? (
              <>
                <h2>现在想问什么？</h2>
                <p>
                  {notesCount > 0
                    ? `我会先在你 ${notesCount} 篇笔记里找一找，再结合今天的任务回答。`
                    : "你的笔记会成为我的上下文。写下第一篇后，我会记得你在想什么。"}
                </p>
                <div className="quick-ai-suggestions">
                  {SUGGESTIONS.map((suggestion) => {
                    const Icon = suggestion.icon;
                    return (
                      <button
                        key={suggestion.title}
                        type="button"
                        className="quick-ai-suggestion"
                        onClick={() => submit(suggestion.prompt)}
                      >
                        <span className="quick-ai-suggestion-icon" aria-hidden="true">
                          <Icon size={14} />
                        </span>
                        <strong>{suggestion.title}</strong>
                        <ArrowUpRight size={13} className="quick-ai-suggestion-arrow" aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <h2>先接入一个 AI 模型</h2>
                <p>支持 DeepSeek、OpenAI 或任何 OpenAI 兼容接口，Key 只保存在本机。</p>
                <button type="button" className="quick-ai-setup-btn" onClick={() => setSettingsOpen(true)}>
                  <Sparkles size={13} /> 去配置
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="quick-ai-messages">
            {displayMessages.map((message) =>
              message.role === "user" ? (
                <div className="chat-user-row" key={message.id}>
                  <div className="chat-user-bubble">{message.content}</div>
                  <span className="chat-time">{formatTime(message.createdAt)}</span>
                </div>
              ) : (
                <div className="chat-ai-row" key={message.id}>
                  <div className="chat-ai-avatar">
                    <Sparkles size={13} />
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
                            onClick={() => openSource(source.id)}
                          >
                            <FileText size={11} /> {source.title}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="chat-ai-actions">
                      <button type="button" onClick={() => void copyMessage(message)}>
                        {copiedId === message.id ? <Check size={12} /> : <Copy size={12} />}
                        {copiedId === message.id ? "已复制" : "复制"}
                      </button>
                      <button type="button" onClick={() => void handleSaveAsNote(message)}>
                        <FileText size={12} /> 存为笔记
                      </button>
                    </div>
                  </div>
                </div>
              ),
            )}

            {showStreaming && streaming && (
              <div className="chat-ai-row is-streaming">
                <div className="chat-ai-avatar">
                  <Sparkles size={13} />
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
          </div>
        )}

        {error && (
          <div className="quick-ai-error">
            <span>{error}</span>
            <button type="button" onClick={() => setSettingsOpen(true)}>
              检查设置 <Settings2 size={12} />
            </button>
          </div>
        )}
      </div>

      <div className="quick-ai-composer">
        <textarea
          ref={textareaRef}
          className="quick-ai-input"
          rows={2}
          value={input}
          placeholder="问点什么…"
          aria-label="向 AI 提问"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit(input);
          }}
        />
        <div className="quick-ai-bar">
          <button
            type="button"
            className={cn("quick-ai-context", useNotes && "is-on")}
            onClick={toggleUseNotes}
            title={useNotes ? "已开启笔记检索，点击关闭" : "开启笔记检索"}
          >
            <BookOpen size={12} />
            引用笔记
            {useNotes && notesCount > 0 && <span>{notesCount}</span>}
          </button>
          <span className="quick-ai-hint">Enter 发送</span>
          {busy ? (
            <button
              type="button"
              className="quick-ai-send is-stop"
              onClick={() => stop()}
              aria-label="停止生成"
              title="停止生成"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="quick-ai-send"
              disabled={!input.trim()}
              onClick={() => submit(input)}
              aria-label="发送"
              title="发送（Enter）"
            >
              <Send size={14} />
            </button>
          )}
        </div>
        <p className="quick-ai-local">仅保存在本机</p>
      </div>
    </section>
  );

  return createPortal(
    <>
      {open ? panel : null}
      {!open && !hidden ? fab : null}
    </>,
    document.body,
  );
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
