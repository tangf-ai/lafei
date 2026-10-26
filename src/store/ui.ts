import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AISettings, AppView, FontScale, NoteMode, TaskFilter, ThemeMode } from "../types";
import { DEFAULT_AI } from "../lib/ai";

interface UIState {
  view: AppView;
  activeNoteId: string | null;
  tagFilter: string | null;
  noteMode: NoteMode;
  /** 正文栏宽度（px），桌面端可拖动调整 */
  contentWidth: number;
  /** 分栏模式下左侧编辑区的宽度比例（0.25 - 0.75） */
  splitRatio: number;
  /** 笔记编辑器右侧大纲面板是否展开 */
  outlineOpen: boolean;
  /** 聚焦模式：除当前段落外的行变淡 */
  focusMode: boolean;
  /** 打字机模式：光标保持在视野中央 */
  typewriterMode: boolean;
  theme: ThemeMode;
  fontScale: FontScale;
  sidebarCollapsed: boolean;
  notesListCollapsed: boolean;
  ai: AISettings;
  settingsOpen: boolean;
  commandOpen: boolean;
  aiPanelOpen: boolean;
  taskDetailId: string | null;
  taskFilter: TaskFilter;
  /** 从任务页「AI 分诊」带进助手输入框的一句话 */
  assistantDraft: string | null;
  folderRoot: string | null;
  agentAccessEnabled: boolean;
  setView: (view: AppView) => void;
  openNote: (id: string, options?: { keepTagFilter?: boolean }) => void;
  closeNote: () => void;
  setTagFilter: (tag: string | null) => void;
  openTagView: (tag: string) => void;
  setNoteMode: (mode: NoteMode) => void;
  setContentWidth: (width: number) => void;
  setSplitRatio: (ratio: number) => void;
  setOutlineOpen: (open: boolean) => void;
  setFocusMode: (enabled: boolean) => void;
  setTypewriterMode: (enabled: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setFontScale: (scale: FontScale) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setNotesListCollapsed: (collapsed: boolean) => void;
  setAI: (ai: AISettings) => void;
  patchAI: (patch: Partial<AISettings>) => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandOpen: (open: boolean) => void;
  setAIPanelOpen: (open: boolean) => void;
  setTaskDetailId: (id: string | null) => void;
  setTaskFilter: (filter: TaskFilter) => void;
  setAssistantDraft: (draft: string | null) => void;
  setFolderRoot: (root: string | null) => void;
  setAgentAccessEnabled: (enabled: boolean) => void;
}

export const CONTENT_WIDTH_MIN = 560;
export const CONTENT_WIDTH_MAX = 1320;
export const CONTENT_WIDTH_DEFAULT = 760;
export const SPLIT_RATIO_MIN = 0.28;
export const SPLIT_RATIO_MAX = 0.72;
export const SPLIT_RATIO_DEFAULT = 0.5;

export function clampContentWidth(width: number) {
  if (!Number.isFinite(width)) return CONTENT_WIDTH_DEFAULT;
  return Math.round(Math.min(CONTENT_WIDTH_MAX, Math.max(CONTENT_WIDTH_MIN, width)));
}

export function clampSplitRatio(ratio: number) {
  if (!Number.isFinite(ratio)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      view: "today",
      activeNoteId: null,
      tagFilter: null,
      noteMode: "live",
      contentWidth: 760,
      splitRatio: 0.5,
      outlineOpen: false,
      focusMode: false,
      typewriterMode: false,
      theme: "light",
      fontScale: 1,
      sidebarCollapsed: false,
      notesListCollapsed: false,
      ai: DEFAULT_AI,
      settingsOpen: false,
      commandOpen: false,
      aiPanelOpen: false,
      taskDetailId: null,
      taskFilter: "all",
      assistantDraft: null,
      folderRoot: null,
      agentAccessEnabled: false,
      // 切换主视图或打开笔记时收起标签筛选，避免旧标签在另一个视图里悄悄过滤内容
      setView: (view) => set({ view, tagFilter: null }),
      openNote: (id, options) =>
        set((state) => ({
          activeNoteId: id,
          view: "notes",
          aiPanelOpen: false,
          tagFilter: options?.keepTagFilter ? state.tagFilter : null,
        })),
      closeNote: () => set({ activeNoteId: null, aiPanelOpen: false }),
      setTagFilter: (tagFilter) => set({ tagFilter }),
      openTagView: (tag) => set({ tagFilter: tag, view: "tags", aiPanelOpen: false }),
      setNoteMode: (noteMode) => set({ noteMode }),
      setContentWidth: (contentWidth) => set({ contentWidth: clampContentWidth(contentWidth) }),
      setSplitRatio: (splitRatio) => set({ splitRatio: clampSplitRatio(splitRatio) }),
      setOutlineOpen: (outlineOpen) => set({ outlineOpen }),
      setFocusMode: (focusMode) => set({ focusMode }),
      setTypewriterMode: (typewriterMode) => set({ typewriterMode }),
      setTheme: (theme) => set({ theme }),
      setFontScale: (fontScale) => set({ fontScale }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setNotesListCollapsed: (notesListCollapsed) => set({ notesListCollapsed }),
      setAI: (ai) => set({ ai }),
      patchAI: (patch) => set((state) => ({ ai: { ...state.ai, ...patch } })),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setAIPanelOpen: (aiPanelOpen) => set({ aiPanelOpen }),
      setTaskDetailId: (taskDetailId) => set({ taskDetailId }),
      setTaskFilter: (taskFilter) => set({ taskFilter }),
      setAssistantDraft: (assistantDraft) => set({ assistantDraft }),
      setFolderRoot: (folderRoot) => set({ folderRoot }),
      setAgentAccessEnabled: (agentAccessEnabled) => set({ agentAccessEnabled }),
    }),
    {
      name: "lafei:ui",
      version: 2,
      partialize: (state) => ({
        noteMode: state.noteMode,
        contentWidth: state.contentWidth,
        splitRatio: state.splitRatio,
        outlineOpen: state.outlineOpen,
        focusMode: state.focusMode,
        typewriterMode: state.typewriterMode,
        theme: state.theme,
        fontScale: state.fontScale,
        sidebarCollapsed: state.sidebarCollapsed,
        notesListCollapsed: state.notesListCollapsed,
        ai: state.ai,
        folderRoot: state.folderRoot,
        agentAccessEnabled: state.agentAccessEnabled,
      }),
      migrate: (persisted, version) => {
        const saved = { ...(persisted as Record<string, unknown>) };
        // v2：写作模式升级为「即时预览」，旧的 write 直接迁移到 live
        if (version < 2 && saved.noteMode === "write") {
          saved.noteMode = "live";
        }
        return saved as unknown as UIState;
      },
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UIState>;
        const fontScale =
          typeof saved.fontScale === "number" && [0.9, 1, 1.1, 1.2].includes(saved.fontScale)
            ? saved.fontScale
            : current.fontScale;
        const noteMode: NoteMode =
          saved.noteMode === "live" ||
          saved.noteMode === "source" ||
          saved.noteMode === "split" ||
          saved.noteMode === "read"
            ? saved.noteMode
            : current.noteMode;
        return {
          ...current,
          ...saved,
          noteMode,
          contentWidth: clampContentWidth(saved.contentWidth ?? current.contentWidth),
          splitRatio: clampSplitRatio(saved.splitRatio ?? current.splitRatio),
          fontScale,
          ai: { ...DEFAULT_AI, ...(saved.ai ?? {}) },
        };
      },
    },
  ),
);

interface ToastState {
  toasts: Array<{ id: number; message: string; tone: "default" | "success" | "error" }>;
  push: (message: string, tone?: "default" | "success" | "error") => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (message, tone = "default") => {
    const id = ++toastId;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }].slice(-4) }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, 3600);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function toast(message: string, tone: "default" | "success" | "error" = "default") {
  useToasts.getState().push(message, tone);
}
