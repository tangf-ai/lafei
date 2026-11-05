import { db } from "../db";
import { useUI } from "../store/ui";
import { buildAgentSnapshot } from "./agentSnapshot";
import { agentBackend, type AgentSnapshotStatus } from "./agentBackend";
import { isTauri } from "./util";

let initialized = false;
let timer: number | null = null;
let flushing = false;
let pending = false;
/** 等待「正在进行的导出 + 排队的一轮」结束的调用方（切换开关时用，避免 manifest 停留在旧状态） */
let flushWaiters: Array<() => void> = [];

function settleFlushWaiters() {
  const waiters = flushWaiters;
  flushWaiters = [];
  for (const resolve of waiters) resolve();
}

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
 * 立即把当前笔记和任务写成智能体快照。
 * 需要先在设置里开启「智能体访问」；写入能力同时取决于写入开关。
 */
export async function flushAgentSnapshot(): Promise<AgentSnapshotStatus | null> {
  if (!isTauri || !useUI.getState().agentAccessEnabled) {
    settleFlushWaiters();
    return null;
  }
  if (flushing) {
    pending = true;
    // 等这一轮和排队的一轮跑完，保证设置页切换开关后 manifest 已经反映最新状态
    await new Promise<void>((resolve) => flushWaiters.push(resolve));
    return null;
  }
  flushing = true;
  try {
    const [notes, tasks, status] = await Promise.all([
      db.notes.toArray(),
      db.tasks.toArray(),
      agentBackend.status(),
    ]);
    const state = useUI.getState();
    // 写入必须在读取开启的前提下才可用，manifest 里如实反映
    const writeEnabled = state.agentAccessEnabled && state.agentWriteEnabled;
    const files = buildAgentSnapshot(notes, tasks, status.appVersion, { writeEnabled });
    return await agentBackend.write(files);
  } finally {
    flushing = false;
    if (pending) {
      pending = false;
      void flushAgentSnapshot().catch((error) => {
        console.error("Failed to export queued agent snapshot", error);
      });
    } else {
      settleFlushWaiters();
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
  if (!enabled) {
    // 关闭读取前先关写入并导出一次，让 manifest 的 writer.enabled 及时变成 false
    useUI.getState().setAgentWriteEnabled(false);
    try {
      await flushAgentSnapshot();
    } catch (error) {
      console.error("Failed to update agent snapshot before disabling access", error);
    }
    useUI.getState().setAgentAccessEnabled(false);
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
    return null;
  }
  useUI.getState().setAgentAccessEnabled(true);
  return flushAgentSnapshot();
}

export async function clearAgentSnapshot(): Promise<void> {
  if (!isTauri) return;
  if (timer) {
    window.clearTimeout(timer);
    timer = null;
  }
  await agentBackend.clear();
}
