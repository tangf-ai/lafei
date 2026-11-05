import { createNote, createTask, db, deleteNoteCascade, deleteTask } from "../db";
import type { Priority } from "../types";
import { toast, useUI } from "../store/ui";
import { isTauri, newId } from "./util";
import { agentBackend, type AgentInboxEntry } from "./agentBackend";
import { flushAgentSnapshot } from "./agentExport";

/**
 * 外部智能体写入队列（MCP → agent/inbox → 本机 Dexie）。
 *
 * 链路：MCP server 把 notes_create / tasks_create 请求原子写入
 * <appDataDir>/agent/inbox/<requestId>.json；应用开启写入后轮询解析、落库，
 * 再把请求结算到 inbox/done 或 inbox/failed。前端只调用 Rust 命令，
 * 不直接碰文件系统。
 */

/** 活动记录变化事件：设置页监听后刷新「由智能体创建」列表与队列状态 */
export const AGENT_WRITE_EVENT = "lafei:agent-writes";

const LOG_STORAGE_KEY = "lafei:agent-writes:v1";
const MAX_LOG_ENTRIES = 20;
/** 每轮最多处理 50 条，避免一次积压把界面卡住 */
const MAX_REQUESTS_PER_ROUND = 50;
const POLL_INTERVAL_MS = 800;
const MAX_TITLE_LENGTH = 200;
const MAX_NOTE_CONTENT = 262144;
const MAX_TASK_DESCRIPTION = 65536;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 64;

export type AgentWriteStatus = "applied" | "rejected";

export interface AgentWriteLogItem {
  id: string;
  kind: "note" | "task";
  entityId: string;
  title: string;
  at: number;
  requestId: string;
  client: string | null;
  status: AgentWriteStatus;
  error?: string;
}

interface AppliedEntity {
  kind: "note" | "task";
  entityId: string;
  title: string;
}

type ValidPayload =
  | { op: "notes.create"; title: string; content: string; tags: string[]; pinned: boolean }
  | {
      op: "tasks.create";
      title: string;
      description: string;
      dueDate: string | null;
      priority: Priority;
      tags: string[];
      noteId: string | null;
    };

/** payload 不符合契约时抛出，错误文案会写进 failed/ 的 result.error 并提示用户 */
class AgentWriteValidationError extends Error {}

let initialized = false;
let pollTimer: number | null = null;
let processing = false;
/** 已创建但结算失败的实体：按 requestId 记住，下一轮只补结算 */
const pendingSettlements = new Map<string, AppliedEntity>();
/** 已经提示过的 requestId：结算失败重试时不要每轮都弹一次同样的话 */
const announcedRequests = new Set<string>();
const MAX_ANNOUNCED_REQUESTS = 500;

/** 返回 true 表示这是该请求第一次出现，需要加入本轮的提示汇总 */
function isFirstAnnouncement(requestId: string) {
  if (announcedRequests.has(requestId)) return false;
  announcedRequests.add(requestId);
  if (announcedRequests.size > MAX_ANNOUNCED_REQUESTS) {
    const oldest = announcedRequests.values().next().value;
    if (oldest) announcedRequests.delete(oldest);
  }
  return true;
}

function textLength(value: string) {
  // 按 Unicode 码点计数，与 JSON Schema 的 maxLength 口径一致
  return Array.from(value).length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeTitle(raw: unknown, label: string): string {
  if (typeof raw !== "string") throw new AgentWriteValidationError(`${label}不能为空`);
  const title = raw.trim();
  if (!title) throw new AgentWriteValidationError(`${label}不能为空`);
  if (textLength(title) > MAX_TITLE_LENGTH) {
    throw new AgentWriteValidationError(`${label}最多 ${MAX_TITLE_LENGTH} 个字符`);
  }
  return title;
}

function normalizeBody(raw: unknown, label: string, maxLength: number): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new AgentWriteValidationError(`${label}必须是字符串`);
  if (textLength(raw) > maxLength) {
    throw new AgentWriteValidationError(`${label}最多 ${maxLength} 个字符`);
  }
  return raw;
}

function normalizeTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AgentWriteValidationError("标签必须是字符串数组");
  if (raw.length > MAX_TAGS) throw new AgentWriteValidationError(`标签最多 ${MAX_TAGS} 个`);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") throw new AgentWriteValidationError("标签必须是字符串");
    // 契约：逐个 trim、去掉开头的 #、1–64 字符、去重
    const tag = item.trim().replace(/^#+/, "").trim();
    if (!tag) throw new AgentWriteValidationError("标签不能为空");
    if (textLength(tag) > MAX_TAG_LENGTH) {
      throw new AgentWriteValidationError(`单个标签最多 ${MAX_TAG_LENGTH} 个字符`);
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function normalizePinned(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== "boolean") throw new AgentWriteValidationError("置顶标记必须是布尔值");
  return raw;
}

function isRealDayKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function normalizeDueDate(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new AgentWriteValidationError("截止日期必须是 YYYY-MM-DD 字符串或 null");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new AgentWriteValidationError("截止日期格式必须是 YYYY-MM-DD");
  }
  if (!isRealDayKey(raw)) throw new AgentWriteValidationError("截止日期不是有效日期");
  return raw;
}

function normalizePriority(raw: unknown): Priority {
  if (raw === undefined || raw === null) return "medium";
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  throw new AgentWriteValidationError("优先级必须是 high、medium 或 low");
}

async function normalizeNoteId(raw: unknown): Promise<string | null> {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw) {
    throw new AgentWriteValidationError("关联笔记的 id 必须是字符串或 null");
  }
  // 契约要求 noteId 必须在本机数据库里真实存在，防止智能体凭空编造关联
  const note = await db.notes.get(raw);
  if (!note) throw new AgentWriteValidationError("关联的笔记不存在或已被删除");
  return raw;
}

function guessKind(op: string): "note" | "task" {
  return op.startsWith("tasks.") ? "task" : "note";
}

function payloadTitle(entry: AgentInboxEntry): string {
  const payload = asRecord(entry.payload);
  const raw = payload?.title;
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_TITLE_LENGTH);
}

function clientOf(entry: AgentInboxEntry): string | null {
  return typeof entry.client === "string" ? entry.client : null;
}

async function parsePayload(entry: AgentInboxEntry): Promise<ValidPayload> {
  if (entry.op !== "notes.create" && entry.op !== "tasks.create") {
    throw new AgentWriteValidationError(`不支持的写入类型：${entry.op || "未知"}`);
  }
  const payload = asRecord(entry.payload);
  if (!payload) throw new AgentWriteValidationError("请求内容必须是 JSON 对象");

  if (entry.op === "notes.create") {
    return {
      op: "notes.create",
      title: normalizeTitle(payload.title, "笔记标题"),
      content: normalizeBody(payload.content, "笔记正文", MAX_NOTE_CONTENT),
      tags: normalizeTags(payload.tags),
      pinned: normalizePinned(payload.pinned),
    };
  }

  return {
    op: "tasks.create",
    title: normalizeTitle(payload.title, "任务标题"),
    description: normalizeBody(payload.description, "任务描述", MAX_TASK_DESCRIPTION),
    dueDate: normalizeDueDate(payload.dueDate),
    priority: normalizePriority(payload.priority),
    tags: normalizeTags(payload.tags),
    noteId: await normalizeNoteId(payload.noteId),
  };
}

function isLogItem(value: unknown): value is AgentWriteLogItem {
  const item = asRecord(value);
  if (!item) return false;
  return (
    typeof item.id === "string" &&
    (item.kind === "note" || item.kind === "task") &&
    typeof item.entityId === "string" &&
    typeof item.title === "string" &&
    typeof item.at === "number" &&
    Number.isFinite(item.at) &&
    typeof item.requestId === "string" &&
    (item.client === null || typeof item.client === "string") &&
    (item.status === "applied" || item.status === "rejected") &&
    (item.error === undefined || typeof item.error === "string")
  );
}

/** 读取本机的智能体写入活动记录（最新在前，最多 20 条） */
export function loadAgentWriteLog(): AgentWriteLogItem[] {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isLogItem)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_LOG_ENTRIES);
  } catch {
    return [];
  }
}

function persistAgentWriteLog(items: AgentWriteLogItem[], notify = true) {
  try {
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(items.slice(0, MAX_LOG_ENTRIES)));
  } catch {
    // localStorage 写不进去（配额/隐私模式）不影响本次创建
  }
  if (notify) notifyAgentWriteLog();
}

/** 通知设置页刷新活动列表与队列数量 */
function notifyAgentWriteLog() {
  window.dispatchEvent(new CustomEvent(AGENT_WRITE_EVENT));
}

/** 记录一条活动；同一个 requestId 重复处理时原地更新，不会产生重复记录 */
function recordAgentWrite(item: AgentWriteLogItem, notify = true) {
  const rest = loadAgentWriteLog().filter((entry) => entry.requestId !== item.requestId);
  persistAgentWriteLog([item, ...rest].slice(0, MAX_LOG_ENTRIES), notify);
}

/** 撤销时把本批实体对应的活动记录一起移除，避免点进已删除的内容 */
function removeAgentWriteLog(entityIds: Set<string>) {
  if (!entityIds.size) return;
  persistAgentWriteLog(loadAgentWriteLog().filter((item) => !entityIds.has(item.entityId)));
}

function agentWriteActive() {
  const state = useUI.getState();
  return isTauri && state.agentAccessEnabled && state.agentWriteEnabled;
}

async function createAppliedEntity(payload: ValidPayload): Promise<AppliedEntity> {
  if (payload.op === "notes.create") {
    const note = await createNote({
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
      pinned: payload.pinned,
    });
    return { kind: "note", entityId: note.id, title: note.title };
  }
  const task = await createTask({
    title: payload.title,
    description: payload.description,
    dueDate: payload.dueDate,
    priority: payload.priority,
    tags: payload.tags,
    noteId: payload.noteId,
  });
  return { kind: "task", entityId: task.id, title: task.title };
}

async function settleApplied(entry: AgentInboxEntry, entity: AppliedEntity): Promise<void> {
  await agentBackend.inboxResolve({
    file: entry.file,
    status: "applied",
    entityKind: entity.kind,
    entityId: entity.entityId,
    title: entity.title,
  });
}

/** 处理单条请求：校验 → 落库 → 结算。校验失败抛 AgentWriteValidationError */
async function applyEntry(entry: AgentInboxEntry): Promise<AppliedEntity> {
  const pendingEntity = pendingSettlements.get(entry.requestId);
  if (pendingEntity) {
    // 上一轮实体已创建但结算失败：本轮只补结算，绝不重复创建
    try {
      await settleApplied(entry, pendingEntity);
      pendingSettlements.delete(entry.requestId);
    } catch {
      // 结算仍失败：保留在 pendingSettlements，下一轮继续补
    }
    return pendingEntity;
  }

  const payload = await parsePayload(entry);
  const entity = await createAppliedEntity(payload);
  pendingSettlements.set(entry.requestId, entity);
  try {
    await settleApplied(entry, entity);
    pendingSettlements.delete(entry.requestId);
  } catch {
    // 实体已落库，只是请求文件结算失败；保留 pendingSettlements 让下一轮补结算
  }
  return entity;
}

async function rejectEntry(entry: AgentInboxEntry, error: string, notify = true): Promise<void> {
  try {
    await agentBackend.inboxResolve({ file: entry.file, status: "rejected", error });
  } catch (resolveError) {
    // 结算失败时文件仍留在 inbox，下一轮会再次校验并拒绝
    console.error("Failed to settle rejected agent request", resolveError);
  }
  recordAgentWrite(
    {
      id: newId(),
      kind: guessKind(entry.op),
      entityId: "",
      title: payloadTitle(entry),
      at: Date.now(),
      requestId: entry.requestId,
      client: clientOf(entry),
      status: "rejected",
      error,
    },
    notify,
  );
}

function summarizeCreated(entities: AppliedEntity[]) {
  const noteCount = entities.filter((entity) => entity.kind === "note").length;
  const taskCount = entities.length - noteCount;
  const parts: string[] = [];
  if (noteCount) parts.push(`${noteCount} 篇笔记`);
  if (taskCount) parts.push(`${taskCount} 个任务`);
  return parts.join("、");
}

async function undoCreated(entities: AppliedEntity[]): Promise<void> {
  try {
    // 先删任务再删笔记：deleteNoteCascade 会把关联任务的 noteId 置空，顺序在这里不影响结果
    for (const entity of entities.filter((item) => item.kind === "task")) {
      await deleteTask(entity.entityId);
    }
    for (const entity of entities.filter((item) => item.kind === "note")) {
      await deleteNoteCascade(entity.entityId);
    }
    const ids = new Set(entities.map((entity) => entity.entityId));
    const ui = useUI.getState();
    // 正在编辑/查看被撤销的内容时顺手关掉，避免停留在空白详情
    if (ui.activeNoteId && ids.has(ui.activeNoteId)) ui.closeNote();
    if (ui.taskDetailId && ids.has(ui.taskDetailId)) ui.setTaskDetailId(null);
    removeAgentWriteLog(ids);
    toast("已撤销智能体创建的内容", "success");
  } catch (error) {
    console.error("Failed to undo agent-created entities", error);
    toast("撤销失败，请稍后重试", "error");
  }
}

function announceBatch(created: AppliedEntity[], failures: string[]) {
  if (created.length) {
    toast(`外部智能体新建了 ${summarizeCreated(created)}`, "success", {
      label: "撤销",
      onClick: () => {
        void undoCreated(created);
      },
    });
  }
  if (failures.length === 1) {
    toast(`外部智能体的写入请求未通过校验：${failures[0]}`, "error");
  } else if (failures.length > 1) {
    toast(`外部智能体有 ${failures.length} 个写入请求未通过校验，例如：${failures[0]}`, "error");
  }
}

/**
 * 处理一轮队列：单飞，最多 50 条/轮。
 * 单条失败会把请求结算到 failed/ 并继续下一条，不会卡住后面的请求。
 */
export async function processAgentInboxOnce(): Promise<void> {
  if (!isTauri || !agentWriteActive() || processing) return;
  processing = true;
  try {
    const entries = await agentBackend.inboxList();
    if (!entries.length) return;

    const created: AppliedEntity[] = [];
    const failures: string[] = [];
    let processed = 0;
    for (const entry of entries.slice(0, MAX_REQUESTS_PER_ROUND)) {
      // 用户中途关闭写入时立刻停手，剩下的请求留给下次开启
      if (!agentWriteActive()) break;
      processed += 1;
      const announce = isFirstAnnouncement(entry.requestId);
      try {
        const entity = await applyEntry(entry);
        if (announce) created.push(entity);
        // 一轮只派发一次活动变更事件，避免设置页开着时每条请求都触发一次刷新
        recordAgentWrite(
          {
            id: newId(),
            kind: entity.kind,
            entityId: entity.entityId,
            title: entity.title,
            at: Date.now(),
            requestId: entry.requestId,
            client: clientOf(entry),
            status: "applied",
          },
          false,
        );
      } catch (error) {
        const message =
          error instanceof AgentWriteValidationError
            ? error.message
            : "写入本机数据库失败，请稍后重试";
        await rejectEntry(entry, message, false);
        if (announce) failures.push(message);
      }
    }
    if (processed) notifyAgentWriteLog();
    announceBatch(created, failures);
  } catch (error) {
    // 队列读取失败（Rust 命令异常）不打扰用户，等下一轮
    console.error("Failed to process agent inbox", error);
  } finally {
    processing = false;
  }
}

function syncPolling() {
  if (agentWriteActive()) {
    if (pollTimer === null) {
      pollTimer = window.setInterval(() => {
        void processAgentInboxOnce();
      }, POLL_INTERVAL_MS);
      // 开启后不等第一个间隔，立刻处理一次积压
      void processAgentInboxOnce();
    }
    return;
  }
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 注册写入队列轮询：仅桌面端，读取与写入都开启时才生效 */
export function initializeAgentWriteQueue() {
  if (!isTauri || initialized) return;
  initialized = true;

  syncPolling();
  useUI.subscribe((state, previous) => {
    if (
      state.agentAccessEnabled !== previous.agentAccessEnabled ||
      state.agentWriteEnabled !== previous.agentWriteEnabled
    ) {
      syncPolling();
    }
  });

  const kick = () => {
    if (!agentWriteActive()) return;
    syncPolling();
    void processAgentInboxOnce();
  };
  window.addEventListener("focus", kick);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });
}

/**
 * 切换写入开关：写 UI 状态 → 立即刷新快照 manifest → 立刻处理一次积压。
 * 读取关闭时写入视为关闭，直接忽略开启请求。
 */
export async function setAgentWriteEnabled(enabled: boolean): Promise<void> {
  const state = useUI.getState();
  if (enabled && !state.agentAccessEnabled) return;
  state.setAgentWriteEnabled(enabled);
  // 不依赖订阅（例如初始化前手动调用）也要让轮询立即跟随开关
  syncPolling();
  try {
    await flushAgentSnapshot();
  } finally {
    if (enabled) void processAgentInboxOnce();
  }
}
