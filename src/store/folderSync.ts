import { create } from "zustand";

export type FolderSyncPhase = "disabled" | "idle" | "syncing" | "error";

interface FolderSyncState {
  phase: FolderSyncPhase;
  lastSyncedAt: number | null;
  error: string | null;
  lastMessage: string | null;
  setPhase: (phase: FolderSyncPhase) => void;
  setError: (error: string | null) => void;
  markSynced: (message?: string) => void;
  reset: () => void;
}

export const useFolderSync = create<FolderSyncState>((set) => ({
  phase: "disabled",
  lastSyncedAt: null,
  error: null,
  lastMessage: null,
  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error, phase: error ? "error" : "idle" }),
  markSynced: (message) =>
    set({ phase: "idle", lastSyncedAt: Date.now(), error: null, lastMessage: message ?? null }),
  reset: () => set({ phase: "disabled", lastSyncedAt: null, error: null, lastMessage: null }),
}));
