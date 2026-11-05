import type { AgentFile } from "./agentSnapshot";

export interface AgentSnapshotStatus {
  dir: string;
  appVersion: string;
  exists: boolean;
  modifiedAt: number | null;
  fileCount: number;
  notes: number;
  tasks: number;
  /** inbox/ 里等待处理的有效请求数 */
  pendingRequests: number;
  mcpPath: string;
  mcpExists: boolean;
}

/** 队列里的一个写入请求，字段由 Rust 侧 agent_inbox_list 原样返回 */
export interface AgentInboxEntry {
  /** 文件名，例如 "req-1762345678901-3f9a1c2e.json" */
  file: string;
  /** 去掉 .json 的请求 id */
  requestId: string;
  op: string;
  client: string | null;
  createdAt: number;
  /** 请求里的 payload，业务字段由前端再校验 */
  payload: unknown;
}

export interface AgentInboxResolveParams {
  /** 只允许 basename，Rust 侧会再校验 */
  file: string;
  status: "applied" | "rejected";
  entityKind?: "note" | "task";
  entityId?: string;
  title?: string;
  error?: string;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(command, args);
}

export const agentBackend = {
  status: () => invoke<AgentSnapshotStatus>("agent_snapshot_status"),
  write: (files: AgentFile[]) => invoke<AgentSnapshotStatus>("write_agent_snapshot", { files }),
  clear: () => invoke<void>("clear_agent_snapshot"),
  /** 读取当前待处理队列（不递归，最多 100 条，按 createdAt 升序） */
  inboxList: () => invoke<AgentInboxEntry[]>("agent_inbox_list"),
  /** 把请求结算到 done/ 或 failed/，成功后删除原请求文件 */
  inboxResolve: (params: AgentInboxResolveParams) =>
    invoke<void>("agent_inbox_resolve", { ...params }),
};
