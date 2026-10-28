import { create } from "zustand";

export type FolderSyncPhase = "disabled" | "idle" | "syncing" | "error";

interface FolderSyncState {
  phase: FolderSyncPhase;
  lastSyncedAt: number | null;
  error: string | null;
  lastMessage: string | null;
  /** 下一次定时同步的时间戳；未启用定时同步或没连接仓库时为 null */
  nextSyncAt: number | null;
  setPhase: (phase: FolderSyncPhase) => void;
  setError: (error: string | null) => void;
  markSynced: (message?: string) => void;
  setNextSyncAt: (at: number | null) => void;
  reset: () => void;
}

export const useFolderSync = create<FolderSyncState>((set) => ({
  phase: "disabled",
  lastSyncedAt: null,
  error: null,
  lastMessage: null,
  nextSyncAt: null,
  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error, phase: error ? "error" : "idle" }),
  markSynced: (message) =>
    set({ phase: "idle", lastSyncedAt: Date.now(), error: null, lastMessage: message ?? null }),
  setNextSyncAt: (nextSyncAt) => set({ nextSyncAt }),
  reset: () =>
    set({ phase: "disabled", lastSyncedAt: null, error: null, lastMessage: null, nextSyncAt: null }),
}));
