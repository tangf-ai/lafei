import type { AgentFile } from "./agentSnapshot";

export interface AgentSnapshotStatus {
  dir: string;
  appVersion: string;
  exists: boolean;
  modifiedAt: number | null;
  fileCount: number;
  notes: number;
  tasks: number;
  mcpPath: string;
  mcpExists: boolean;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

export const agentBackend = {
  status: () => invoke<AgentSnapshotStatus>("agent_snapshot_status"),
  write: (files: AgentFile[]) => invoke<AgentSnapshotStatus>("write_agent_snapshot", { files }),
  clear: () => invoke<void>("clear_agent_snapshot"),
};
