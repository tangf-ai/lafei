import { db } from "../db";
import type { Chat, ChatMessage, EntityKind, Note, Task, Tombstone } from "../types";
import { useUI } from "../store/ui";
import { useFolderSync } from "../store/folderSync";
import { isTauri, newId } from "./util";
import { folderBackend } from "./folderBackend";
import { updateVaultCounts } from "./vaultRegistry";
import {
  chatFilePath,
  makeManifest,
  noteFilePath,
  parseStoreFiles,
  serializeChatFile,
  serializeManifest,
  serializeNoteFile,
  serializeTaskFile,
  serializeTombstones,
  taskFilePath,
  type ChatBundle,
  type ParsedStore,
  type StoreManifest,
} from "./folderFormat";

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  removed: number;
  warnings: number;
  at: number;
}

export interface FolderCandidate {
  root: string;
  store: ParsedStore;
  hasRemoteData: boolean;
  counts: { notes: number; tasks: number; chats: number };
  remoteDevice: string | null;
  remoteUpdatedAt: number | null;
}

interface DirtyRecord {
  kind: EntityKind;
  id: string;
}

const dirty = new Map<string, DirtyRecord>();
let initialized = false;
let hooksRegistered = false;
let lifecycleBound = false;
let suppressHooks = false;
let flushTimer: number | null = null;
let currentSync: Promise<SyncSummary> | null = null;
let operationQueue: Promise<unknown> = Promise.resolve();
let lastManifestStamp: string | null = null;
let lastManifestCheck = 0;
/** 定时同步的 setTimeout 句柄；null 表示当前没有排期 */
let scheduledTimer: number | null = null;
/** 正在启用 / 切换数据仓库：这段时间不该再插入一次完整同步 */
let vaultTransition = false;
/** 导入 / 清空等全量覆盖期间暂停自动同步，避免把中间状态写进文件夹 */
let autoSyncSuspended = false;

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(task, task);
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "文件夹同步时出现未知错误";
}

function getRoot() {
  return useUI.getState().folderRoot;
}

function getDeviceId() {
  const key = "lafei:device-id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = newId();
    localStorage.setItem(key, id);
  }
  return id;
}

function getDeviceName() {
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone / iPad";
  if (/Linux/i.test(ua)) return "Linux";
  return "Lafei 设备";
}

function stampOf(manifest: StoreManifest | null) {
  if (!manifest) return null;
  return `${manifest.writerId}:${manifest.updatedAt}:${manifest.counts.notes}:${manifest.counts.tasks}:${manifest.counts.chats}`;
}

function sortTombstones(tombstones: Tombstone[]) {
  return [...tombstones].sort((a, b) => a.key.localeCompare(b.key));
}

function newer<T extends { updatedAt: number }>(local: T | undefined, remote: T | undefined): T | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return local.updatedAt >= remote.updatedAt ? local : remote;
}

/**
 * 任务的「较新者」：在通用规则上补一条平局时的补救。
 *
 * 0.19.1 之前的版本读回任务时会丢掉手动象限（连属性都不写），但保留 updatedAt：
 * 本地因此留下「和文件夹里的任务同一时间戳、quadrant 却缺失 / 为 null」的旧行。
 * 平局按本地赢的话，同步会把文件夹里的手动象限改回自动落位（看起来就是象限永远
 * 同步不过来，两台设备之间还会来回覆盖）。平局时以「带着手动象限」的那份为准：
 * 本地旧行会拿回象限，本地有象限则补写回文件；两边都有或都没有时仍以文件夹为准，
 * 保证内容没变就不重写。
 */
function newerTask(local: Task | undefined, remote: Task | undefined): Task | undefined {
  if (!local) return remote;
  if (!remote) return local;
  if (local.updatedAt === remote.updatedAt) {
    const localManual = local.quadrant != null;
    const remoteManual = remote.quadrant != null;
    if (localManual !== remoteManual) return localManual ? local : remote;
    return remote;
  }
  return local.updatedAt > remote.updatedAt ? local : remote;
}

/**
 * 更老版本（任务还没有象限这个概念的版本）写出来的任务文件里根本没有 quadrant 字段，
 * 读回后本地行也是「属性缺失」，它无法表达「用户主动选了自动」——主动改回自动写的是
 * null，createTask / 数据库迁移也都会留下 null。所以属性缺失的一方可以直接把另一份里的
 * 手动象限继承过来，不用比较 updatedAt（老版本做过任何无关编辑都会用缺失字段的整行
 * 覆盖文件，光靠时间戳救不回来），也不改 updatedAt，避免两台设备互相刷新时间戳。
 */
function inheritQuadrant(task: Task, other: Task | undefined): Task {
  if (!other) return task;
  if (task.quadrant !== undefined) return task;
  if (other.quadrant == null) return task;
  return { ...task, quadrant: other.quadrant };
}

/**
 * 结构化比较时忽略对象键顺序。
 * 迁移或旧备份补出来的 tags 可能排在对象末尾，而文件夹解析会按固定顺序重建对象；
 * 直接用 JSON.stringify 比较会让同一份数据每次同步都被判定为“已变化”。
 */
function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sameJson(a: unknown, b: unknown) {
  return stableJson(a) === stableJson(b);
}

/**
 * 任务比较前先把可缺省的 quadrant 归一成 null：种子数据 / 老文件里没有这个字段，
 * 直接比较会把「undefined vs null」当成变化，导致每次完整同步都把所有任务重写一遍
 * （iCloud 一直在重新上传同一个任务文件，两台设备之间还会互相触发同步）。
 */
function comparableTask(task: Task) {
  return { ...task, quadrant: task.quadrant ?? null };
}

function sameTask(a: Task, b: Task) {
  return sameJson(comparableTask(a), comparableTask(b));
}

function sortMessages(messages: ChatMessage[]) {
  return [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

async function localChatBundles() {
  const [chats, messages] = await Promise.all([db.chats.toArray(), db.messages.toArray()]);
  const byChat = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const list = byChat.get(message.chatId) ?? [];
    list.push(message);
    byChat.set(message.chatId, list);
  }
  return new Map<string, ChatBundle>(
    chats.map((chat) => [chat.id, { chat, messages: sortMessages(byChat.get(chat.id) ?? []) }]),
  );
}

function mergeTombstones(local: Tombstone[], remote: Tombstone[]) {
  const map = new Map<string, Tombstone>();
  for (const tombstone of [...local, ...remote]) {
    const existing = map.get(tombstone.key);
    if (!existing || tombstone.deletedAt > existing.deletedAt) map.set(tombstone.key, tombstone);
  }
  return [...map.values()];
}

function markError(error: unknown) {
  useFolderSync.getState().setError(errorMessage(error));
}

function registerHooks() {
  if (hooksRegistered) return;
  hooksRegistered = true;

  db.notes.hook("creating", (_key, note) => queueChange("note", note.id));
  db.notes.hook("updating", (_mods, key) => queueChange("note", String(key)));
  db.notes.hook("deleting", (key) => queueChange("note", String(key)));

  db.tasks.hook("creating", (_key, task) => queueChange("task", task.id));
  db.tasks.hook("updating", (_mods, key) => queueChange("task", String(key)));
  db.tasks.hook("deleting", (key) => queueChange("task", String(key)));

  db.chats.hook("creating", (_key, chat) => queueChange("chat", chat.id));
  db.chats.hook("updating", (_mods, key) => queueChange("chat", String(key)));
  db.chats.hook("deleting", (key) => queueChange("chat", String(key)));

  db.messages.hook("creating", (_key, message) => queueChange("chat", message.chatId));
  db.messages.hook("updating", (_mods, _key, message) => queueChange("chat", message.chatId));
  db.messages.hook("deleting", (_key, message) => queueChange("chat", message.chatId));
}

function queueChange(kind: EntityKind, id: string) {
  if (suppressHooks) return;
  const root = getRoot();
  if (!root) return;
  dirty.set(`${kind}:${id}`, { kind, id });
  scheduleFlush(root);
}

function scheduleFlush(root: string) {
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    if (!getRoot() || getRoot() !== root) return;
    withLock(() => flushDirtyUnlocked(root)).catch((error) => {
      markError(error);
    });
  }, 700);
}

async function ensureTombstone(kind: EntityKind, id: string) {
  const key = `${kind}:${id}`;
  const existing = await db.tombstones.get(key);
  if (existing) return false;
  await db.tombstones.put({ key, kind, id, deletedAt: Date.now() });
  return true;
}

async function writeManifest(root: string) {
  const [notes, tasks, chats] = await Promise.all([db.notes.count(), db.tasks.count(), db.chats.count()]);
  const manifest = makeManifest(getDeviceId(), getDeviceName(), notes, tasks, chats);
  await folderBackend.writeFile(root, "manifest.json", serializeManifest(manifest));
  lastManifestStamp = stampOf(manifest);
  // 「最近的数据目录」里的数量跟着一起更新，避免一直显示接入时的 0 个任务
  updateVaultCounts(root, { notes, tasks, chats });
}

async function writeTombstones(root: string) {
  const tombstones = sortTombstones(await db.tombstones.toArray());
  await folderBackend.writeFile(root, "tombstones.json", serializeTombstones(tombstones));
}

async function syncSingle(kind: EntityKind, id: string, root: string) {
  if (kind === "note") {
    const note = await db.notes.get(id);
    if (note) {
      await folderBackend.writeFile(root, noteFilePath(id), serializeNoteFile(note));
    } else {
      await ensureTombstone("note", id);
      await folderBackend.removeFile(root, noteFilePath(id));
    }
    return;
  }
  if (kind === "task") {
    const task = await db.tasks.get(id);
    if (task) {
      await folderBackend.writeFile(root, taskFilePath(id), serializeTaskFile(task));
    } else {
      await ensureTombstone("task", id);
      await folderBackend.removeFile(root, taskFilePath(id));
    }
    return;
  }
  const chat = await db.chats.get(id);
  if (!chat) {
    await ensureTombstone("chat", id);
    await folderBackend.removeFile(root, chatFilePath(id));
    return;
  }
  const messages = await db.messages.where("chatId").equals(id).toArray();
  await folderBackend.writeFile(root, chatFilePath(id), serializeChatFile(chat, sortMessages(messages)));
}

async function flushDirtyUnlocked(root: string): Promise<number> {
  if (!getRoot() || getRoot() !== root) return 0;
  const pending = [...dirty.values()];
  dirty.clear();
  if (!pending.length) return 0;

  try {
    for (const record of pending) {
      await syncSingle(record.kind, record.id, root);
    }
    await writeTombstones(root);
    await writeManifest(root);
    useFolderSync.getState().markSynced(
      `已写入 ${pending.length} 项更改`,
    );
    return pending.length;
  } catch (error) {
    markError(error);
    throw error;
  }
}

function mergedChatMessages(local: ChatMessage[], remote: ChatMessage[]) {
  const map = new Map<string, ChatMessage>();
  for (const message of remote) map.set(message.id, message);
  for (const message of local) map.set(message.id, message);
  return sortMessages([...map.values()]);
}

export async function fetchFolderStore(root: string): Promise<ParsedStore> {
  const files = await folderBackend.readFiles(root);
  return parseStoreFiles(files);
}

export async function syncFolderNow(): Promise<SyncSummary> {
  const root = getRoot();
  if (!root) throw new Error("尚未启用文件夹存储");
  if (!initialized) initializeLifecycle();
  if (currentSync) return currentSync;

  useFolderSync.getState().setPhase("syncing");
  currentSync = withLock(async () => {
    const pending = [...dirty.values()];
    dirty.clear();
    for (const record of pending) {
      if (record.kind === "note" && !(await db.notes.get(record.id))) {
        await ensureTombstone("note", record.id);
      } else if (record.kind === "task" && !(await db.tasks.get(record.id))) {
        await ensureTombstone("task", record.id);
      } else if (record.kind === "chat" && !(await db.chats.get(record.id))) {
        await ensureTombstone("chat", record.id);
      }
    }
    return performFullSync(root);
  })
    .then((summary) => {
      useFolderSync.getState().markSynced(
        summary.uploaded || summary.downloaded || summary.removed
          ? `上传 ${summary.uploaded} · 下载 ${summary.downloaded} · 删除 ${summary.removed}`
          : "已是最新",
      );
      return summary;
    })
    .catch((error) => {
      markError(error);
      throw error;
    })
    .finally(() => {
      currentSync = null;
    });

  return currentSync;
}

async function performFullSync(root: string): Promise<SyncSummary> {
  const [remote, localNotes, localTasks, localChats, localTombstones] = await Promise.all([
    fetchFolderStore(root),
    db.notes.toArray(),
    db.tasks.toArray(),
    localChatBundles(),
    db.tombstones.toArray(),
  ]);

  const localNoteMap = new Map(localNotes.map((note) => [note.id, note]));
  const localTaskMap = new Map(localTasks.map((task) => [task.id, task]));
  const remoteNoteMap = new Map(remote.notes.map((note) => [note.id, note]));
  const remoteTaskMap = new Map(remote.tasks.map((task) => [task.id, task]));
  const remoteChatMap = new Map(remote.chats.map((bundle) => [bundle.chat.id, bundle]));
  const cleanedRemoteTombstones = remote.tombstones.filter((tombstone) => ["note", "task", "chat"].includes(tombstone.kind));
  const tombstones = mergeTombstones(localTombstones, cleanedRemoteTombstones);
  const tombstoneMap = new Map(tombstones.map((tombstone) => [tombstone.key, tombstone]));

  const mergedNotes: Note[] = [];
  const notesToPut: Note[] = [];
  const notesToDelete: string[] = [];
  const notesToWrite = new Map<string, Note>();
  const removedPaths = new Set<string>();
  let downloaded = 0;
  let removed = 0;

  const noteIds = new Set([...localNoteMap.keys(), ...remoteNoteMap.keys()]);
  for (const id of noteIds) {
    const local = localNoteMap.get(id);
    const remoteNote = remoteNoteMap.get(id);
    const candidate = newer(local, remoteNote);
    if (!candidate) continue;
    const tombstone = tombstoneMap.get(`note:${id}`);
    if (tombstone && tombstone.deletedAt >= candidate.updatedAt) {
      if (local) notesToDelete.push(id);
      if (remoteNote) {
        removedPaths.add(noteFilePath(id));
        removed += 1;
      }
      continue;
    }
    mergedNotes.push(candidate);
    if (!local) {
      notesToPut.push(candidate);
      downloaded += 1;
    } else if (candidate === remoteNote && !sameJson(local, remoteNote)) {
      notesToPut.push(candidate);
      downloaded += 1;
    }
    if (!remoteNote || !sameJson(candidate, remoteNote)) notesToWrite.set(id, candidate);
  }

  const mergedTasks: Task[] = [];
  const tasksToPut: Task[] = [];
  const tasksToDelete: string[] = [];
  const tasksToWrite = new Map<string, Task>();
  const taskIds = new Set([...localTaskMap.keys(), ...remoteTaskMap.keys()]);
  for (const id of taskIds) {
    const local = localTaskMap.get(id);
    const remoteTask = remoteTaskMap.get(id);
    const base = newerTask(local, remoteTask);
    if (!base) continue;
    // 老版本的整行覆盖会连 quadrant 属性一起带走：先把另一边的手动象限继承回来，
    // 再照常按内容比较决定落库 / 写回文件。
    const candidate = inheritQuadrant(base, base === local ? remoteTask : local);
    const tombstone = tombstoneMap.get(`task:${id}`);
    if (tombstone && tombstone.deletedAt >= candidate.updatedAt) {
      if (local) tasksToDelete.push(id);
      if (remoteTask) {
        removedPaths.add(taskFilePath(id));
        removed += 1;
      }
      continue;
    }
    mergedTasks.push(candidate);
    if (!local) {
      tasksToPut.push(candidate);
      downloaded += 1;
    } else if (!sameTask(local, candidate)) {
      tasksToPut.push(candidate);
      downloaded += 1;
    }
    if (!remoteTask || !sameTask(candidate, remoteTask)) tasksToWrite.set(id, candidate);
  }

  const mergedChats: ChatBundle[] = [];
  const chatsToPut: Chat[] = [];
  const chatsToDelete: string[] = [];
  const messagesToReplace: Array<{ chatId: string; messages: ChatMessage[] }> = [];
  const chatsToWrite = new Map<string, ChatBundle>();
  const chatIds = new Set([...localChats.keys(), ...remoteChatMap.keys()]);
  for (const id of chatIds) {
    const local = localChats.get(id);
    const remoteChat = remoteChatMap.get(id);
    const candidateChat = newer(local?.chat, remoteChat?.chat);
    if (!candidateChat) continue;
    const tombstone = tombstoneMap.get(`chat:${id}`);
    if (tombstone && tombstone.deletedAt >= candidateChat.updatedAt) {
      if (local) chatsToDelete.push(id);
      if (remoteChat) {
        removedPaths.add(chatFilePath(id));
        removed += 1;
      }
      continue;
    }

    const messages = mergedChatMessages(local?.messages ?? [], remoteChat?.messages ?? []);
    const merged = { chat: candidateChat, messages };
    mergedChats.push(merged);

    const localChanged =
      !local ||
      !sameJson(local.chat, candidateChat) ||
      !sameJson(local.messages, messages);
    if (localChanged) {
      if (!local || !sameJson(local.chat, candidateChat)) chatsToPut.push(candidateChat);
      if (!local || !sameJson(local.messages, messages)) {
        messagesToReplace.push({ chatId: id, messages });
      }
      if (remoteChat && local) downloaded += 1;
    }

    if (
      !remoteChat ||
      !sameJson(remoteChat.chat, candidateChat) ||
      !sameJson(remoteChat.messages, messages)
    ) {
      chatsToWrite.set(id, merged);
    }
  }

  const localTombstoneKeys = new Set(localTombstones.map((tombstone) => tombstone.key));
  const tombstonesToAdd = tombstones.filter((tombstone) => !localTombstoneKeys.has(tombstone.key));
  const mergedTombstonesSorted = sortTombstones(tombstones);
  const remoteTombstonesSorted = sortTombstones(cleanedRemoteTombstones);
  const remoteHasTombstonesFile = remote.files.some((file) => file.path === "tombstones.json");
  const tombstonesChanged =
    !remoteHasTombstonesFile || !sameJson(mergedTombstonesSorted, remoteTombstonesSorted);

  const shouldApplyLocal =
    notesToPut.length ||
    notesToDelete.length ||
    tasksToPut.length ||
    tasksToDelete.length ||
    chatsToPut.length ||
    chatsToDelete.length ||
    messagesToReplace.length ||
    tombstonesToAdd.length;

  if (shouldApplyLocal) {
    suppressHooks = true;
    try {
      await db.transaction("rw", db.notes, db.tasks, db.chats, db.messages, db.tombstones, async () => {
        for (const id of notesToDelete) await db.notes.delete(id);
        if (notesToPut.length) await db.notes.bulkPut(notesToPut);
        for (const id of tasksToDelete) await db.tasks.delete(id);
        if (tasksToPut.length) await db.tasks.bulkPut(tasksToPut);
        for (const id of chatsToDelete) {
          await db.messages.where("chatId").equals(id).delete();
          await db.chats.delete(id);
        }
        if (chatsToPut.length) await db.chats.bulkPut(chatsToPut);
        for (const replacement of messagesToReplace) {
          await db.messages.where("chatId").equals(replacement.chatId).delete();
          if (replacement.messages.length) await db.messages.bulkPut(replacement.messages);
        }
        if (tombstonesToAdd.length) await db.tombstones.bulkPut(tombstonesToAdd);
      });
    } finally {
      suppressHooks = false;
    }
  }

  for (const path of removedPaths) {
    await folderBackend.removeFile(root, path);
  }
  for (const note of notesToWrite.values()) {
    await folderBackend.writeFile(root, noteFilePath(note.id), serializeNoteFile(note));
  }
  for (const task of tasksToWrite.values()) {
    await folderBackend.writeFile(root, taskFilePath(task.id), serializeTaskFile(task));
  }
  for (const bundle of chatsToWrite.values()) {
    await folderBackend.writeFile(root, chatFilePath(bundle.chat.id), serializeChatFile(bundle.chat, bundle.messages));
  }

  if (tombstonesChanged) {
    await folderBackend.writeFile(root, "tombstones.json", serializeTombstones(mergedTombstonesSorted));
  }

  const remoteManifest = remote.manifest;
  const counts = {
    notes: mergedNotes.length,
    tasks: mergedTasks.length,
    chats: mergedChats.length,
  };
  const countsChanged =
    !remoteManifest ||
    remoteManifest.counts.notes !== counts.notes ||
    remoteManifest.counts.tasks !== counts.tasks ||
    remoteManifest.counts.chats !== counts.chats;
  const remoteChanged = notesToWrite.size > 0 || tasksToWrite.size > 0 || chatsToWrite.size > 0 || removedPaths.size > 0 || tombstonesChanged;

  if (remoteChanged || countsChanged) {
    const manifest = makeManifest(getDeviceId(), getDeviceName(), counts.notes, counts.tasks, counts.chats);
    await folderBackend.writeFile(root, "manifest.json", serializeManifest(manifest));
    lastManifestStamp = stampOf(manifest);
  } else {
    lastManifestStamp = stampOf(remoteManifest);
  }

  updateVaultCounts(root, counts);

  const summary: SyncSummary = {
    uploaded: notesToWrite.size + tasksToWrite.size + chatsToWrite.size,
    downloaded,
    removed,
    warnings: remote.warnings.length,
    at: Date.now(),
  };
  useFolderSync.getState().markSynced(
    summary.uploaded || summary.downloaded || summary.removed
      ? `上传 ${summary.uploaded} · 下载 ${summary.downloaded} · 删除 ${summary.removed}`
      : "已是最新",
  );
  return summary;
}

/* ---------- 定时同步 ---------- */

/** 每次重排都递增，用来忽略已经入队的旧定时器回调 */
let scheduleGeneration = 0;
/** 当前定时器计划触发的时刻；休眠 / 挂起后用来判断是否错过 */
let scheduledDueAt: number | null = null;
/** 导入 / 清空等全量覆盖可能嵌套调用，用计数确保最后一个结束时才恢复 */
let autoSyncSuspendDepth = 0;

function clearScheduledSync() {
  scheduleGeneration += 1;
  scheduledDueAt = null;
  if (scheduledTimer !== null) {
    window.clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
}

function armScheduledSync(delayMs: number) {
  clearScheduledSync();
  const generation = scheduleGeneration;
  const nextAt = Date.now() + delayMs;
  scheduledDueAt = nextAt;
  useFolderSync.getState().setNextSyncAt(nextAt);
  scheduledTimer = window.setTimeout(() => {
    // 句柄可能已经被新的排期替换，旧回调只负责退出，不能清掉新定时器
    if (generation !== scheduleGeneration) return;
    scheduledTimer = null;
    scheduledDueAt = null;
    void runScheduledSync();
  }, delayMs);
}

/**
 * 按设置里的间隔重排下一次定时同步。
 * 启用 / 关闭数据仓库、修改间隔、切换仓库、断开连接时都会调用；
 * 关闭（0 分钟）、暂停自动同步或没连接仓库时只清掉定时器并把「下次同步」置空。
 */
export function refreshSyncSchedule() {
  clearScheduledSync();
  if (autoSyncSuspended) {
    useFolderSync.getState().setNextSyncAt(null);
    return;
  }
  const root = getRoot();
  const minutes = useUI.getState().syncIntervalMinutes;
  if (!isFolderStorageAvailable() || !root || !Number.isFinite(minutes) || minutes <= 0) {
    useFolderSync.getState().setNextSyncAt(null);
    return;
  }
  armScheduledSync(minutes * 60_000);
}

/**
 * 导入 / 清空备份前调用：暂停定时同步与自动检查，并等在途的完整同步结束，
 * 避免「清空本机 → 自动同步把旧内容又从文件夹拉回来」。
 */
export async function suspendAutoSync(): Promise<void> {
  autoSyncSuspendDepth += 1;
  autoSyncSuspended = true;
  clearScheduledSync();
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  useFolderSync.getState().setNextSyncAt(null);
  if (currentSync) {
    try {
      await currentSync;
    } catch {
      // 同步自身的错误已经写进 status store，这里只负责等它收尾
    }
  }
}

export function resumeAutoSync() {
  autoSyncSuspendDepth = Math.max(0, autoSyncSuspendDepth - 1);
  if (autoSyncSuspendDepth > 0) return;
  autoSyncSuspended = false;
  refreshSyncSchedule();
}

async function runScheduledSync() {
  if (autoSyncSuspended) {
    useFolderSync.getState().setNextSyncAt(null);
    return;
  }
  const root = getRoot();
  const minutes = useUI.getState().syncIntervalMinutes;
  if (!root || !isFolderStorageAvailable() || !Number.isFinite(minutes) || minutes <= 0) {
    useFolderSync.getState().setNextSyncAt(null);
    return;
  }
  // 三路同步最多一个在飞：手动 / 切换 / manifest 触发的同步刚跑过，
  // 这次定时任务就算完成，直接排下一次，避免再补一次全量。
  if (currentSync || vaultTransition) {
    refreshSyncSchedule();
    return;
  }

  useFolderSync.getState().setNextSyncAt(null);
  try {
    await syncFolderNow();
    refreshSyncSchedule();
  } catch {
    // 失败原因已经写进 store；缩短等待后再试，避免一整天都不同步
    armScheduledSync(Math.min(minutes * 60_000, 5 * 60_000));
  }
}

function initializeLifecycle() {
  if (lifecycleBound) return;
  lifecycleBound = true;
  registerHooks();

  const maybeCheck = () => {
    if (document.visibilityState !== "visible") return;
    // 系统休眠 / WebView 挂起可能让定时器晚到甚至丢失：醒来后补做一次
    if (
      scheduledDueAt !== null &&
      Date.now() >= scheduledDueAt + 2_000 &&
      !currentSync &&
      !vaultTransition &&
      !autoSyncSuspended
    ) {
      clearScheduledSync();
      void runScheduledSync();
    }
    const now = Date.now();
    if (now - lastManifestCheck < 12_000) return;
    lastManifestCheck = now;
    void checkRemoteManifest();
  };

  window.addEventListener("focus", maybeCheck);
  document.addEventListener("visibilitychange", maybeCheck);
  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void checkRemoteManifest();
    }
  }, 30_000);
}

async function checkRemoteManifest() {
  if (autoSyncSuspended || vaultTransition) return;
  const root = getRoot();
  if (!root || !initialized || currentSync) return;
  try {
    const raw = await folderBackend.readManifest(root);
    // 读文件期间可能开始切换仓库 / 手动同步，读到的内容就过期了
    if (autoSyncSuspended || vaultTransition || currentSync || getRoot() !== root) return;
    if (!raw) {
      if (lastManifestStamp !== null) await syncFolderNow();
      return;
    }
    const parsed = JSON.parse(raw) as StoreManifest;
    const stamp = stampOf(parsed);
    if (stamp && stamp !== lastManifestStamp) {
      await syncFolderNow();
    }
  } catch {
    // Automatic checks stay quiet; manual sync surfaces the error.
  }
}

export async function initializeFolderSync() {
  if (initialized) return;
  initialized = true;
  registerHooks();
  initializeLifecycle();

  const root = getRoot();
  if (!isFolderStorageAvailable() || !root) {
    useFolderSync.getState().reset();
    return;
  }

  useFolderSync.setState({ phase: "syncing", error: null });
  refreshSyncSchedule();
  try {
    await syncFolderNow();
  } catch {
    // 启动时首次同步失败也要在 5 分钟内重试，而不是等满一个完整间隔
    const minutes = useUI.getState().syncIntervalMinutes;
    if (getRoot() && Number.isFinite(minutes) && minutes > 0) {
      armScheduledSync(Math.min(minutes * 60_000, 5 * 60_000));
    }
  }
}

export async function loadFolderCandidate(path: string): Promise<FolderCandidate> {
  const root = await folderBackend.prepare(path);
  const store = await fetchFolderStore(root);
  const counts = { notes: store.notes.length, tasks: store.tasks.length, chats: store.chats.length };
  return {
    root,
    store,
    hasRemoteData: counts.notes + counts.tasks + counts.chats > 0,
    counts,
    remoteDevice: store.manifest?.deviceName ?? null,
    remoteUpdatedAt: store.manifest?.updatedAt ?? null,
  };
}

export async function selectFolderCandidate(): Promise<FolderCandidate | null> {
  if (currentSync) throw new Error("正在同步，请稍后再更换文件夹");
  const selected = await folderBackend.pickFolder();
  if (!selected) return null;

  try {
    return await loadFolderCandidate(selected);
  } catch (error) {
    markError(error);
    throw error;
  }
}

async function replaceLocalFromStore(store: ParsedStore | null) {
  const messages = store?.chats.flatMap((bundle) => bundle.messages) ?? [];
  suppressHooks = true;
  try {
    await db.transaction("rw", db.notes, db.tasks, db.chats, db.messages, db.tombstones, async () => {
      await db.notes.clear();
      await db.tasks.clear();
      await db.chats.clear();
      await db.messages.clear();
      await db.tombstones.clear();
      if (store) {
        if (store.notes.length) await db.notes.bulkPut(store.notes);
        if (store.tasks.length) await db.tasks.bulkPut(store.tasks);
        if (store.chats.length) await db.chats.bulkPut(store.chats.map((bundle) => bundle.chat));
        if (messages.length) await db.messages.bulkPut(messages);
        if (store.tombstones.length) await db.tombstones.bulkPut(store.tombstones);
      }
    });
    localStorage.setItem("lafei:seeded:v1", "1");
  } finally {
    suppressHooks = false;
  }
}

function normalizedRoot(root: string) {
  return root.replace(/[\\/]+$/, "");
}

/**
 * 切换到另一个数据仓库。
 * 当前仓库会先完整同步到它自己的目录；只有同步成功才允许清空本机缓存并载入目标目录，
 * 避免把尚未落盘的数据丢掉。旧目录不会被删除，可随时切回。
 */
export async function switchFolderVault(candidate: FolderCandidate): Promise<void> {
  if (currentSync) throw new Error("正在同步，请稍后再切换数据目录");
  if (vaultTransition) throw new Error("正在切换数据目录，请稍后再试");
  const currentRoot = getRoot();
  if (!currentRoot) {
    throw new Error("请先启用文件夹存储并同步当前数据，再切换数据目录");
  }
  if (normalizedRoot(currentRoot) === normalizedRoot(candidate.root)) return;

  // 从「切走前的最后一次同步」开始就挡住定时同步，直到新仓库载入完成：
  // 否则定时器可能在这中间插入一次同步，把新仓库的内容写进旧目录。
  vaultTransition = true;
  try {
    try {
      await syncFolderNow();
    } catch (error) {
      throw new Error(`当前仓库同步失败，已取消切换：${errorMessage(error)}`);
    }

    // 重新读取目标目录，避免使用确认弹窗打开后过期的快照
    const store = await fetchFolderStore(candidate.root);
    const counts = { notes: store.notes.length, tasks: store.tasks.length, chats: store.chats.length };
    const hasRemoteData = counts.notes + counts.tasks + counts.chats > 0;

    if (flushTimer) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    dirty.clear();

    try {
      await replaceLocalFromStore(hasRemoteData ? store : null);
    } catch (error) {
      markError(error);
      throw new Error(`载入目标仓库失败，仍保留当前仓库：${errorMessage(error)}`);
    }

    useUI.getState().setFolderRoot(candidate.root);
    lastManifestStamp = null;
    if (!initialized) {
      initialized = true;
      initializeLifecycle();
    }
    useFolderSync.getState().markSynced("已切换数据目录");
  } finally {
    vaultTransition = false;
    refreshSyncSchedule();
  }
}

export async function enableFolderCandidate(
  candidate: FolderCandidate,
  mode: "merge" | "folder",
): Promise<{ root: string; summary: SyncSummary }> {
  if (currentSync) throw new Error("正在同步，请稍后再试");
  if (vaultTransition) throw new Error("正在切换数据目录，请稍后再试");
  useFolderSync.getState().setPhase("syncing");
  vaultTransition = true;
  try {
    if (mode === "folder") {
      await replaceLocalFromStore(candidate.store);
    }
    useUI.getState().setFolderRoot(candidate.root);
    dirty.clear();
    lastManifestStamp = null;
    if (!initialized) {
      initialized = true;
      initializeLifecycle();
    }
    const summary = await syncFolderNow();
    return { root: candidate.root, summary };
  } catch (error) {
    markError(error);
    throw error;
  } finally {
    vaultTransition = false;
    refreshSyncSchedule();
  }
}

export function disableFolderStorage() {
  useUI.getState().setFolderRoot(null);
  dirty.clear();
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = null;
  lastManifestStamp = null;
  useFolderSync.getState().reset();
  refreshSyncSchedule();
}

export async function mirrorAllToFolder(): Promise<SyncSummary | null> {
  const root = getRoot();
  if (!root) return null;
  useFolderSync.getState().setPhase("syncing");

  try {
    const summary = await withLock(async () => {
      await folderBackend.clearData(root);
      const [notes, tasks, chats, tombstones] = await Promise.all([
        db.notes.toArray(),
        db.tasks.toArray(),
        localChatBundles(),
        db.tombstones.toArray(),
      ]);
      for (const note of notes) {
        await folderBackend.writeFile(root, noteFilePath(note.id), serializeNoteFile(note));
      }
      for (const task of tasks) {
        await folderBackend.writeFile(root, taskFilePath(task.id), serializeTaskFile(task));
      }
      for (const bundle of chats.values()) {
        await folderBackend.writeFile(root, chatFilePath(bundle.chat.id), serializeChatFile(bundle.chat, bundle.messages));
      }
      await folderBackend.writeFile(root, "tombstones.json", serializeTombstones(sortTombstones(tombstones)));
      const manifest = makeManifest(getDeviceId(), getDeviceName(), notes.length, tasks.length, chats.size);
      await folderBackend.writeFile(root, "manifest.json", serializeManifest(manifest));
      lastManifestStamp = stampOf(manifest);
      dirty.clear();
      const result: SyncSummary = {
        uploaded: notes.length + tasks.length + chats.size,
        downloaded: 0,
        removed: 0,
        warnings: 0,
        at: Date.now(),
      };
      useFolderSync.getState().markSynced(`已完整写入 ${result.uploaded} 项`);
      return result;
    });
    return summary;
  } catch (error) {
    markError(error);
    throw error;
  }
}

export function isFolderStorageAvailable() {
  return isTauri;
}
