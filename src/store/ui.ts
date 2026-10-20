import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AISettings, AppView, NoteMode, TaskFilter, ThemeMode } from "../types";
import { DEFAULT_AI } from "../lib/ai";

interface UIState {
  view: AppView;
  activeNoteId: string | null;
  tagFilter: string | null;
  noteMode: NoteMode;
  theme: ThemeMode;
  ai: AISettings;
  settingsOpen: boolean;
  commandOpen: boolean;
  aiPanelOpen: boolean;
  taskDetailId: string | null;
  taskFilter: TaskFilter;
  folderRoot: string | null;
  setView: (view: AppView) => void;
  openNote: (id: string) => void;
  closeNote: () => void;
  setTagFilter: (tag: string | null) => void;
  setNoteMode: (mode: NoteMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setAI: (ai: AISettings) => void;
  patchAI: (patch: Partial<AISettings>) => void;
  setSettingsOpen: (open: boolean) => void;
  setCommandOpen: (open: boolean) => void;
  setAIPanelOpen: (open: boolean) => void;
  setTaskDetailId: (id: string | null) => void;
  setTaskFilter: (filter: TaskFilter) => void;
  setFolderRoot: (root: string | null) => void;
}

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      view: "today",
      activeNoteId: null,
      tagFilter: null,
      noteMode: "write",
      theme: "light",
      ai: DEFAULT_AI,
      settingsOpen: false,
      commandOpen: false,
      aiPanelOpen: false,
      taskDetailId: null,
      taskFilter: "all",
      folderRoot: null,
      setView: (view) => set({ view }),
      openNote: (id) => set({ activeNoteId: id, view: "notes", aiPanelOpen: false }),
      closeNote: () => set({ activeNoteId: null, aiPanelOpen: false }),
      setTagFilter: (tagFilter) => set({ tagFilter }),
      setNoteMode: (noteMode) => set({ noteMode }),
      setTheme: (theme) => set({ theme }),
      setAI: (ai) => set({ ai }),
      patchAI: (patch) => set((state) => ({ ai: { ...state.ai, ...patch } })),
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      setCommandOpen: (commandOpen) => set({ commandOpen }),
      setAIPanelOpen: (aiPanelOpen) => set({ aiPanelOpen }),
      setTaskDetailId: (taskDetailId) => set({ taskDetailId }),
      setTaskFilter: (taskFilter) => set({ taskFilter }),
      setFolderRoot: (folderRoot) => set({ folderRoot }),
    }),
    {
      name: "lafei:ui",
      version: 1,
      partialize: (state) => ({
        noteMode: state.noteMode,
        theme: state.theme,
        ai: state.ai,
        folderRoot: state.folderRoot,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UIState>;
        return {
          ...current,
          ...saved,
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
