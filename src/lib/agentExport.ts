import { db } from "../db";
import { useUI } from "../store/ui";
import { buildAgentSnapshot } from "./agentSnapshot";
import { agentBackend, type AgentSnapshotStatus } from "./agentBackend";
import { isTauri } from "./util";

let initialized = false;
let timer: number | null = null;
let flushing = false;
let pending = false;

function scheduleAgentExport() {
  if (!isTauri || !useUI.getState().agentAccessEnabled) return;
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void flushAgentSnapshot().catch((error) => {
      console.error("Failed to export agent snapshot", error);
    });
  }, 900);
}

/**
 * 立即把当前笔记和任务写成只读智能体快照。
 * 需要先在设置里开启「智能体访问」。
 */
export async function flushAgentSnapshot(): Promise<AgentSnapshotStatus | null> {
  if (!isTauri || !useUI.getState().agentAccessEnabled) return null;
  if (flushing) {
    pending = true;
    return null;
  }
  flushing = true;
  try {
    const [notes, tasks, status] = await Promise.all([
      db.notes.toArray(),
      db.tasks.toArray(),
      agentBackend.status(),
    ]);
    const files = buildAgentSnapshot(notes, tasks, status.appVersion);
    return await agentBackend.write(files);
  } finally {
    flushing = false;
    if (pending) {
      pending = false;
      void flushAgentSnapshot().catch((error) => {
        console.error("Failed to export queued agent snapshot", error);
      });
    }
  }
}

/** 注册数据库变更监听，并在已开启时先导出一次。 */
export function initializeAgentExport() {
  if (!isTauri || initialized) return;
  initialized = true;

  db.notes.hook("creating", scheduleAgentExport);
  db.notes.hook("updating", scheduleAgentExport);
  db.notes.hook("deleting", scheduleAgentExport);
  db.tasks.hook("creating", scheduleAgentExport);
  db.tasks.hook("updating", scheduleAgentExport);
  db.tasks.hook("deleting", scheduleAgentExport);

  if (useUI.getState().agentAccessEnabled) {
    void flushAgentSnapshot().catch((error) => {
      console.error("Failed to export initial agent snapshot", error);
    });
  }
}

/** 用户切换开关时调用：关闭后保留已导出文件，但不再自动更新。 */
export async function setAgentAccess(enabled: boolean): Promise<AgentSnapshotStatus | null> {
  useUI.getState().setAgentAccessEnabled(enabled);
  if (enabled) return flushAgentSnapshot();
  if (timer) {
    window.clearTimeout(timer);
    timer = null;
  }
  return null;
}

export async function clearAgentSnapshot(): Promise<void> {
  if (!isTauri) return;
  if (timer) {
    window.clearTimeout(timer);
    timer = null;
  }
  await agentBackend.clear();
}
