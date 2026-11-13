import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AISettings,
  AppView,
  FontScale,
  NoteMode,
  TaskFilter,
  TaskViewMode,
  ThemeMode,
  WallpaperSettings,
} from "../types";
import { DEFAULT_AI } from "../lib/ai";
import { SYNC_INTERVAL_DEFAULT, normalizeSyncInterval } from "../lib/syncSchedule";
import { WALLPAPER_DEFAULT, normalizeWallpaper } from "../lib/wallpaper";

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
  /** 桌面背景：内置光雾预设、本机图片，或纯色 */
  wallpaper: WallpaperSettings;
  fontScale: FontScale;
  sidebarCollapsed: boolean;
  /** 左侧栏宽度（px，拖动侧栏右边缘调整） */
  sidebarWidth: number;
  notesListCollapsed: boolean;
  ai: AISettings;
  settingsOpen: boolean;
  commandOpen: boolean;
  aiPanelOpen: boolean;
  /** 右下角的快速对话浮窗是否展开 */
  quickAssistantOpen: boolean;
  taskDetailId: string | null;
  taskFilter: TaskFilter;
  /** 任务页视图：列表 / 矩阵 / 日历 */
  taskView: TaskViewMode;
  /** 从任务页「AI 分诊」带进助手输入框的一句话 */
  assistantDraft: string | null;
  folderRoot: string | null;
  /** 数据仓库定时同步间隔（分钟，0 = 关闭）；默认每 30 分钟完整合并一次 */
  syncIntervalMinutes: number;
  agentAccessEnabled: boolean;
  /** 是否允许外部智能体通过 MCP 新建笔记/任务（依赖读取开关，读取关闭时视为关闭） */
  agentWriteEnabled: boolean;
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
  setWallpaper: (patch: Partial<WallpaperSettings>) => void;
  setFontScale: (scale: FontScale) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setNotesListCollapsed: (collapsed: boolean) => void;
  setAI: (ai: AISettings) => void;
  patchAI: (patch: Partial<AISettings>) => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandOpen: (open: boolean) => void;
  setAIPanelOpen: (open: boolean) => void;
  setQuickAssistantOpen: (open: boolean) => void;
  toggleQuickAssistant: () => void;
  setTaskDetailId: (id: string | null) => void;
  setTaskFilter: (filter: TaskFilter) => void;
  setTaskView: (view: TaskViewMode) => void;
  setAssistantDraft: (draft: string | null) => void;
  setFolderRoot: (root: string | null) => void;
  setSyncIntervalMinutes: (minutes: number) => void;
  setAgentAccessEnabled: (enabled: boolean) => void;
  setAgentWriteEnabled: (enabled: boolean) => void;
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
      wallpaper: WALLPAPER_DEFAULT,
      fontScale: 1,
      sidebarCollapsed: false,
      sidebarWidth: 236,
      notesListCollapsed: false,
      ai: DEFAULT_AI,
      settingsOpen: false,
      commandOpen: false,
      aiPanelOpen: false,
      quickAssistantOpen: false,
      taskDetailId: null,
      taskFilter: "all",
      taskView: "matrix",
      assistantDraft: null,
      folderRoot: null,
      syncIntervalMinutes: SYNC_INTERVAL_DEFAULT,
      agentAccessEnabled: false,
      agentWriteEnabled: false,
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
      setWallpaper: (patch) =>
        set((state) => ({ wallpaper: normalizeWallpaper({ ...state.wallpaper, ...patch }) })),
      setFontScale: (fontScale) => set({ fontScale }),
      setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
      setSidebarWidth: (sidebarWidth) =>
        set({ sidebarWidth: Math.min(380, Math.max(200, Math.round(sidebarWidth))) }),
      setNotesListCollapsed: (notesListCollapsed) => set({ notesListCollapsed }),
      setAI: (ai) => set({ ai }),
      patchAI: (patch) => set((state) => ({ ai: { ...state.ai, ...patch } })),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setAIPanelOpen: (aiPanelOpen) => set({ aiPanelOpen }),
      setQuickAssistantOpen: (quickAssistantOpen) => set({ quickAssistantOpen }),
      toggleQuickAssistant: () => set((state) => ({ quickAssistantOpen: !state.quickAssistantOpen })),
      setTaskDetailId: (taskDetailId) => set({ taskDetailId }),
      setTaskFilter: (taskFilter) => set({ taskFilter }),
      setTaskView: (taskView) => set({ taskView }),
      setAssistantDraft: (assistantDraft) => set({ assistantDraft }),
      setFolderRoot: (folderRoot) => set({ folderRoot }),
      setSyncIntervalMinutes: (minutes) => set({ syncIntervalMinutes: normalizeSyncInterval(minutes) }),
      setAgentAccessEnabled: (agentAccessEnabled) => set({ agentAccessEnabled }),
      setAgentWriteEnabled: (agentWriteEnabled) => set({ agentWriteEnabled }),
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
        wallpaper: state.wallpaper,
        fontScale: state.fontScale,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        notesListCollapsed: state.notesListCollapsed,
        taskView: state.taskView,
        ai: state.ai,
        folderRoot: state.folderRoot,
        syncIntervalMinutes: state.syncIntervalMinutes,
        agentAccessEnabled: state.agentAccessEnabled,
        agentWriteEnabled: state.agentWriteEnabled,
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
        // 写入依赖读取：读取没开时，旧的写入标记一律视为关闭，避免重新打开读取时意外放开写入
        const agentAccessEnabled = saved.agentAccessEnabled === true;
        const agentWriteEnabled = agentAccessEnabled && saved.agentWriteEnabled === true;
        return {
          ...current,
          ...saved,
          noteMode,
          contentWidth: clampContentWidth(saved.contentWidth ?? current.contentWidth),
          splitRatio: clampSplitRatio(saved.splitRatio ?? current.splitRatio),
          fontScale,
          wallpaper: normalizeWallpaper(saved.wallpaper),
          syncIntervalMinutes: normalizeSyncInterval(saved.syncIntervalMinutes ?? current.syncIntervalMinutes),
          ai: { ...DEFAULT_AI, ...(saved.ai ?? {}) },
          agentAccessEnabled,
          agentWriteEnabled,
        };
      },
    },
  ),
);

export type ToastTone = "default" | "success" | "error";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  /** 可选操作按钮，例如「撤销」；带操作的提示停留更久 */
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
  push: (message: string, tone?: ToastTone, action?: ToastAction) => void;
  dismiss: (id: number) => void;
}

/** 普通提示停留 3.6 秒；带操作按钮的提示留出 8 秒给用户点「撤销」 */
const TOAST_DURATION = 3600;
const TOAST_ACTION_DURATION = 8000;

let toastId = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (message, tone = "default", action) => {
    const id = ++toastId;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone, action }].slice(-4) }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
    }, action ? TOAST_ACTION_DURATION : TOAST_DURATION);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function toast(message: string, tone: ToastTone = "default", action?: ToastAction) {
  useToasts.getState().push(message, tone, action);
}
