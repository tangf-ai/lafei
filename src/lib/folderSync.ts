import { db } from "../db";
import type { Chat, ChatMessage, EntityKind, Note, Task, Tombstone } from "../types";
import { useUI } from "../store/ui";
import { useFolderSync } from "../store/folderSync";
import { isTauri, newId } from "./util";
import { folderBackend } from "./folderBackend";
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
    const candidate = newer(local, remoteTask);
    if (!candidate) continue;
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
    } else if (candidate === remoteTask && !sameJson(local, remoteTask)) {
      tasksToPut.push(candidate);
      downloaded += 1;
    }
    if (!remoteTask || !sameJson(candidate, remoteTask)) tasksToWrite.set(id, candidate);
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

function initializeLifecycle() {
  if (lifecycleBound) return;
  lifecycleBound = true;
  registerHooks();

  const maybeCheck = () => {
    if (document.visibilityState !== "visible") return;
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
  const root = getRoot();
  if (!root || !initialized || currentSync) return;
  try {
    const raw = await folderBackend.readManifest(root);
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
  try {
    await syncFolderNow();
  } catch {
    // Status store already contains the error; the folder stays configured for retry.
  }
}

export async function selectFolderCandidate(): Promise<FolderCandidate | null> {
  if (currentSync) throw new Error("正在同步，请稍后再更换文件夹");
  const selected = await folderBackend.pickFolder();
  if (!selected) return null;

  try {
    const root = await folderBackend.prepare(selected);
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
  } catch (error) {
    markError(error);
    throw error;
  }
}

async function replaceLocalFromStore(store: ParsedStore) {
  const messages = store.chats.flatMap((bundle) => bundle.messages);
  suppressHooks = true;
  try {
    await db.transaction("rw", db.notes, db.tasks, db.chats, db.messages, db.tombstones, async () => {
      await db.notes.clear();
      await db.tasks.clear();
      await db.chats.clear();
      await db.messages.clear();
      await db.tombstones.clear();
      if (store.notes.length) await db.notes.bulkPut(store.notes);
      if (store.tasks.length) await db.tasks.bulkPut(store.tasks);
      if (store.chats.length) await db.chats.bulkPut(store.chats.map((bundle) => bundle.chat));
      if (messages.length) await db.messages.bulkPut(messages);
      if (store.tombstones.length) await db.tombstones.bulkPut(store.tombstones);
    });
    localStorage.setItem("lafei:seeded:v1", "1");
  } finally {
    suppressHooks = false;
  }
}

export async function enableFolderCandidate(
  candidate: FolderCandidate,
  mode: "merge" | "folder",
): Promise<{ root: string; summary: SyncSummary }> {
  if (currentSync) throw new Error("正在同步，请稍后再试");
  useFolderSync.getState().setPhase("syncing");
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
  }
}

export function disableFolderStorage() {
  useUI.getState().setFolderRoot(null);
  dirty.clear();
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = null;
  lastManifestStamp = null;
  useFolderSync.getState().reset();
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
