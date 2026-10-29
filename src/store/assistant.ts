import { create } from "zustand";
import { useLiveQuery } from "dexie-react-hooks";
import { createNote, db, deleteChatCascade } from "../db";
import type { Chat, ChatMessage, ChatSource } from "../types";
import { AIError, buildChatMessages, isAIConfigured, retrieveNoteContext, streamChat } from "../lib/ai";
import { tagsOf } from "../lib/tags";
import { newId, dueLabel } from "../lib/util";
import { toast, useUI } from "./ui";

/**
 * AI 助手的会话引擎。
 *
 * 完整助手页（AssistantView）和右下角的快速对话浮窗（QuickAssistant）共用这一份状态：
 * 同一个 activeChatId、同一段流式输出、同一份错误信息。这样在浮窗里问一半可以收起，
 * 打开完整助手还能接着看；反过来也一样。消息本身仍然只存在本地 IndexedDB。
 */

export interface StreamingReply {
  chatId: string;
  content: string;
  sources: ChatSource[];
}

interface AssistantChatState {
  /** 当前对话；null 表示「新对话」还没说出第一句话 */
  activeChatId: string | null;
  busy: boolean;
  streaming: StreamingReply | null;
  /** 已落库、等 liveQuery 追上之前先在界面上显示的用户消息 */
  pendingUser: ChatMessage | null;
  error: string;
  /** 是否在回答时检索笔记做上下文 */
  useNotes: boolean;
  /** 首次打开助手时是否已经自动选中过最近一个对话 */
  initialized: boolean;
  /** 首次挂载时选中最近的对话（已经初始化过就不再覆盖用户的选择） */
  initChat: (latestChatId: string | null) => void;
  selectChat: (id: string) => void;
  startNewChat: () => void;
  deleteChat: (chat: Chat) => Promise<void>;
  toggleUseNotes: () => void;
  send: (question: string) => Promise<void>;
  stop: (silent?: boolean) => void;
  /** 把一条回答存成笔记，并打开它 */
  saveAsNote: (message: ChatMessage) => Promise<void>;
}

let abortRef: AbortController | null = null;

/**
 * 「刚点了新对话、还没说第一句」的状态记在 sessionStorage 里，只为了刷新后别又自动跳回旧对话。
 * 用 sessionStorage 而不是 localStorage：关闭应用后这次意图就作废，下次打开还是恢复最近对话。
 */
const FRESH_CHAT_KEY = "lafei:assistant:fresh";

function markFreshChat(fresh: boolean) {
  try {
    if (fresh) sessionStorage.setItem(FRESH_CHAT_KEY, "1");
    else sessionStorage.removeItem(FRESH_CHAT_KEY);
  } catch {
    // 隐私模式等场景 sessionStorage 不可用时，退化成「刷新后回到最近对话」
  }
}

function hasFreshChat() {
  try {
    return sessionStorage.getItem(FRESH_CHAT_KEY) === "1";
  } catch {
    return false;
  }
}

function chatTitle(prompt: string) {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned;
}

function resetTransient() {
  return { streaming: null, pendingUser: null, error: "" };
}

async function saveAssistantMessage(chatId: string, content: string, sources: ChatSource[]) {
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
}

async function readChatMessages(chatId: string): Promise<ChatMessage[]> {
  const items = await db.messages.where("chatId").equals(chatId).toArray();
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export const useAssistantChat = create<AssistantChatState>()((set, get) => ({
  activeChatId: null,
  busy: false,
  streaming: null,
  pendingUser: null,
  error: "",
  useNotes: true,
  initialized: false,

  initChat: (latestChatId) => {
    if (get().initialized) return;
    // 刚点过「新对话」就刷新页面时保持空态，不要自动选回最近一个对话
    if (hasFreshChat()) {
      set({ initialized: true, ...resetTransient() });
      return;
    }
    // 注意：chats 是异步查出来的，第一次拿到的可能是空数组。
    // 只有真的拿到了一个对话才算「初始化过」，否则会错过异步加载完成后的最近对话。
    if (!latestChatId) return;
    set({ activeChatId: latestChatId, initialized: true, ...resetTransient() });
  },

  selectChat: (id) => {
    if (id === get().activeChatId) return;
    get().stop(true);
    markFreshChat(false);
    set({ activeChatId: id, initialized: true, ...resetTransient() });
  },

  startNewChat: () => {
    get().stop(true);
    markFreshChat(true);
    set({ activeChatId: null, initialized: true, ...resetTransient() });
  },

  deleteChat: async (chat) => {
    if (chat.id === get().activeChatId) {
      get().stop(true);
      set({ activeChatId: null, initialized: true, ...resetTransient() });
    }
    await deleteChatCascade(chat.id);
    toast("对话已删除");
  },

  toggleUseNotes: () => set((state) => ({ useNotes: !state.useNotes })),

  stop: (silent = false) => {
    abortRef?.abort();
    abortRef = null;
    set({ busy: false });
    if (!silent) toast("已停止生成");
  },

  send: async (question) => {
    const trimmed = question.trim();
    if (!trimmed || get().busy) return;

    const ai = useUI.getState().ai;
    if (!isAIConfigured(ai)) {
      useUI.getState().setSettingsOpen(true);
      return;
    }

    set({ busy: true, error: "" });
    // 已经开口说话了，就不再是「新对话空态」，刷新后正常恢复这个对话
    markFreshChat(false);

    let chatId = get().activeChatId;
    if (!chatId) {
      const now = Date.now();
      const chat: Chat = { id: newId(), title: chatTitle(trimmed), createdAt: now, updatedAt: now };
      await db.chats.add(chat);
      chatId = chat.id;
      set({ activeChatId: chatId, initialized: true });
    } else {
      await db.chats.update(chatId, { updatedAt: Date.now() });
    }

    const history = (await readChatMessages(chatId))
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-14)
      .map((message) => ({ role: message.role, content: message.content }) as const);

    const retrieved = get().useNotes ? retrieveNoteContext(await db.notes.toArray(), trimmed) : null;
    const sources = retrieved?.sources ?? [];
    const built = buildChatMessages(history, trimmed, retrieved);

    const openTasks = (await db.tasks.toArray()).filter((task) => !task.done).slice(0, 12);
    const taskBlock = openTasks.length
      ? `\n\n用户当前的未完成任务：\n${openTasks
          .map((task) => {
            const tags = tagsOf(task);
            return `- [ ] ${task.title}${tags.length ? ` #${tags.join(" #")}` : ""}${task.dueDate ? `（${dueLabel(task.dueDate).label}）` : ""}${task.priority === "high" ? "（高优先级）" : ""}`;
          })
          .join("\n")}`
      : "";
    built[0] = { ...built[0], content: `${built[0].content}${taskBlock}` };

    const userMessage: ChatMessage = {
      id: newId(),
      chatId,
      role: "user",
      content: trimmed,
      sources: [],
      createdAt: Date.now(),
    };
    set({ pendingUser: userMessage });
    await db.messages.add(userMessage);

    const controller = new AbortController();
    abortRef = controller;
    const streamingChatId = chatId;
    let full = "";
    set({ streaming: { chatId: streamingChatId, content: "", sources } });

    try {
      full = await streamChat({
        settings: ai,
        messages: built,
        signal: controller.signal,
        maxTokens: 1600,
        onDelta: (delta) => {
          full += delta;
          set((state) =>
            state.streaming && state.streaming.chatId === streamingChatId
              ? { ...state, streaming: { ...state.streaming, content: state.streaming.content + delta } }
              : state,
          );
        },
      });
      await saveAssistantMessage(streamingChatId, full, sources);
      set({ streaming: null, error: "" });
    } catch (reason) {
      if ((reason as Error).name === "AbortError") {
        if (full.trim()) await saveAssistantMessage(streamingChatId, full, sources);
        set({ streaming: null });
      } else {
        set({
          error: reason instanceof AIError ? reason.message : "出了点问题，请稍后再试。",
          streaming: null,
        });
      }
    } finally {
      if (abortRef === controller) {
        abortRef = null;
        set({ busy: false });
      }
    }
  },

  saveAsNote: async (message) => {
    const chatId = get().activeChatId;
    const chat = chatId ? await db.chats.get(chatId) : undefined;
    const recent = chatId ? (await readChatMessages(chatId)).slice(-4) : [];
    const hasUserMessage = recent.some((item) => item.role === "user");
    const context = hasUserMessage ? `\n\n---\n\n> 对话来源：${chat?.title ?? "AI 助手"}` : "";

    const firstLine = message.content.split("\n").find((line) => line.trim()) ?? "AI 对话";
    const title = firstLine.replace(/[#*`>]/g, "").trim().slice(0, 40) || "AI 对话";
    const note = await createNote({ title, content: message.content + context, tags: ["AI"] });
    useUI.getState().openNote(note.id);
    toast("已保存为笔记", "success");
  },
}));

/** 某个对话的消息，按创建时间升序；对话还没建立时返回空数组 */
export function useAssistantMessages(chatId: string | null): ChatMessage[] {
  return useLiveQuery(
    async () => {
      if (!chatId) return [] as ChatMessage[];
      return readChatMessages(chatId);
    },
    [chatId],
    [] as ChatMessage[],
  );
}
