import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AISettings, AppView, FontScale, NoteMode, TaskFilter, ThemeMode } from "../types";
import { DEFAULT_AI } from "../lib/ai";

interface UIState {
  view: AppView;
  activeNoteId: string | null;
  tagFilter: string | null;
  noteMode: NoteMode;
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
  folderRoot: string | null;
  agentAccessEnabled: boolean;
  setView: (view: AppView) => void;
  openNote: (id: string, options?: { keepTagFilter?: boolean }) => void;
  closeNote: () => void;
  setTagFilter: (tag: string | null) => void;
  openTagView: (tag: string) => void;
  setNoteMode: (mode: NoteMode) => void;
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
  setFolderRoot: (root: string | null) => void;
  setAgentAccessEnabled: (enabled: boolean) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      view: "today",
      activeNoteId: null,
      tagFilter: null,
      noteMode: "write",
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
      setFolderRoot: (folderRoot) => set({ folderRoot }),
      setAgentAccessEnabled: (agentAccessEnabled) => set({ agentAccessEnabled }),
    }),
    {
      name: "lafei:ui",
      version: 1,
      partialize: (state) => ({
        noteMode: state.noteMode,
        theme: state.theme,
        fontScale: state.fontScale,
        sidebarCollapsed: state.sidebarCollapsed,
        notesListCollapsed: state.notesListCollapsed,
        ai: state.ai,
        folderRoot: state.folderRoot,
        agentAccessEnabled: state.agentAccessEnabled,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UIState>;
        const fontScale =
          typeof saved.fontScale === "number" && [0.9, 1, 1.1, 1.2].includes(saved.fontScale)
            ? saved.fontScale
            : current.fontScale;
        return {
          ...current,
          ...saved,
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
