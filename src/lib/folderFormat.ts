import type { Chat, ChatMessage, ChatSource, Note, Priority, Task, Tombstone } from "../types";

export interface StoreFile {
  path: string;
  content: string;
  modifiedMs: number;
}

export interface StoreManifest {
  app: "lafei";
  format: "folder";
  version: 1;
  writerId: string;
  deviceName: string;
  updatedAt: number;
  counts: {
    notes: number;
    tasks: number;
    chats: number;
  };
}

export interface ChatBundle {
  chat: Chat;
  messages: ChatMessage[];
}

export interface ParsedStore {
  notes: Note[];
  tasks: Task[];
  chats: ChatBundle[];
  tombstones: Tombstone[];
  manifest: StoreManifest | null;
  files: StoreFile[];
  warnings: string[];
}

export function noteFilePath(id: string) {
  return `notes/${id}.md`;
}

export function taskFilePath(id: string) {
  return `tasks/${id}.json`;
}

export function chatFilePath(id: string) {
  return `chats/${id}.json`;
}

export function serializeNoteFile(note: Note) {
  const header = [
    "---",
    `id: ${JSON.stringify(note.id)}`,
    `title: ${JSON.stringify(note.title)}`,
    `tags: ${JSON.stringify(note.tags)}`,
    `pinned: ${note.pinned ? "true" : "false"}`,
    `createdAt: ${note.createdAt}`,
    `updatedAt: ${note.updatedAt}`,
    "---",
  ].join("\n");
  return `${header}\n${note.content}`;
}

export function serializeTaskFile(task: Task) {
  return `${JSON.stringify(task, null, 2)}\n`;
}

export function serializeChatFile(chat: Chat, messages: ChatMessage[]) {
  return `${JSON.stringify({ chat, messages }, null, 2)}\n`;
}

export function serializeTombstones(tombstones: Tombstone[]) {
  return `${JSON.stringify(tombstones, null, 2)}\n`;
}

export function serializeManifest(manifest: StoreManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function asNumber(value: unknown, fallback: number) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asTags(value: unknown) {
  return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
}

function parseSources(value: unknown): ChatSource[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((source) => source && typeof source.id === "string" && typeof source.title === "string")
    .map((source) => ({ id: source.id, title: source.title }));
}

function parseHeaderValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export function parseNoteFile(file: StoreFile): Note | null {
  const text = file.content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const header = text.slice(4, end).split("\n");
  const values: Record<string, unknown> = {};
  for (const line of header) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    values[key] = parseHeaderValue(line.slice(separator + 1));
  }
  const fallbackId = file.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  const id = asString(values.id, fallbackId).trim();
  if (!id) return null;
  const createdAt = asNumber(values.createdAt, file.modifiedMs || Date.now());
  return {
    id,
    title: asString(values.title, ""),
    content: text.slice(end + 5),
    tags: asTags(values.tags),
    pinned: values.pinned === true || values.pinned === "true",
    createdAt,
    updatedAt: Math.max(createdAt, asNumber(values.updatedAt, file.modifiedMs || createdAt)),
  };
}

const PRIORITIES: Priority[] = ["high", "medium", "low"];

export function parseTaskFile(file: StoreFile): Task | null {
  try {
    const parsed = JSON.parse(file.content) as Record<string, unknown>;
    const id = asString(parsed.id).trim();
    if (!id) return null;
    const createdAt = asNumber(parsed.createdAt, file.modifiedMs || Date.now());
    return {
      id,
      title: asString(parsed.title, ""),
      description: asString(parsed.description, ""),
      noteId: typeof parsed.noteId === "string" && parsed.noteId ? parsed.noteId : null,
      dueDate: typeof parsed.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate) ? parsed.dueDate : null,
      priority: PRIORITIES.includes(parsed.priority as Priority) ? (parsed.priority as Priority) : "medium",
      done: parsed.done === true,
      completedAt: typeof parsed.completedAt === "number" ? parsed.completedAt : null,
      createdAt,
      updatedAt: Math.max(createdAt, asNumber(parsed.updatedAt, file.modifiedMs || createdAt)),
    };
  } catch {
    return null;
  }
}

export function parseChatFile(file: StoreFile): ChatBundle | null {
  try {
    const parsed = JSON.parse(file.content) as { chat?: Record<string, unknown>; messages?: unknown[] };
    if (!parsed.chat) return null;
    const chatId = asString(parsed.chat.id).trim();
    if (!chatId) return null;
    const createdAt = asNumber(parsed.chat.createdAt, file.modifiedMs || Date.now());
    const chat: Chat = {
      id: chatId,
      title: asString(parsed.chat.title, "对话"),
      createdAt,
      updatedAt: Math.max(createdAt, asNumber(parsed.chat.updatedAt, file.modifiedMs || createdAt)),
    };
    const messages: ChatMessage[] = [];
    for (const raw of Array.isArray(parsed.messages) ? parsed.messages : []) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const id = asString(item.id);
      const content = asString(item.content);
      if (!id || !content) continue;
      const role = item.role === "user" || item.role === "assistant" ? item.role : null;
      if (!role) continue;
      messages.push({
        id,
        chatId,
        role,
        content,
        sources: parseSources(item.sources),
        createdAt: asNumber(item.createdAt, createdAt),
      });
    }
    return { chat, messages };
  } catch {
    return null;
  }
}

function dedupeByUpdatedAt<T extends { id: string; updatedAt: number }>(items: T[]) {
  const map = new Map<string, T>();
  for (const item of items) {
    const existing = map.get(item.id);
    if (!existing || item.updatedAt > existing.updatedAt) map.set(item.id, item);
  }
  return [...map.values()];
}

export function parseStoreFiles(files: StoreFile[]): ParsedStore {
  const warnings: string[] = [];
  const notes: Note[] = [];
  const tasks: Task[] = [];
  const chats: ChatBundle[] = [];
  let manifest: StoreManifest | null = null;
  let tombstones: Tombstone[] = [];

  for (const file of files) {
    if (file.path === "manifest.json") {
      try {
        const parsed = JSON.parse(file.content) as StoreManifest;
        if (parsed && parsed.app === "lafei") manifest = parsed;
      } catch {
        warnings.push("manifest.json 无法解析");
      }
      continue;
    }
    if (file.path === "tombstones.json") {
      try {
        const parsed = JSON.parse(file.content);
        if (Array.isArray(parsed)) {
          tombstones = parsed
            .filter((item) => item && ["note", "task", "chat"].includes(item.kind) && typeof item.id === "string")
            .map((item) => ({
              key: `${item.kind}:${item.id}`,
              kind: item.kind,
              id: item.id,
              deletedAt: asNumber(item.deletedAt, 0),
            }));
        }
      } catch {
        warnings.push("tombstones.json 无法解析");
      }
      continue;
    }
    if (file.path.startsWith("notes/")) {
      const note = parseNoteFile(file);
      if (note) notes.push(note);
      else warnings.push(`${file.path} 无法解析`);
      continue;
    }
    if (file.path.startsWith("tasks/")) {
      const task = parseTaskFile(file);
      if (task) tasks.push(task);
      else warnings.push(`${file.path} 无法解析`);
      continue;
    }
    if (file.path.startsWith("chats/")) {
      const chat = parseChatFile(file);
      if (chat) chats.push(chat);
      else warnings.push(`${file.path} 无法解析`);
    }
  }

  const chatMap = new Map<string, ChatBundle>();
  for (const bundle of chats) {
    const existing = chatMap.get(bundle.chat.id);
    if (!existing || bundle.chat.updatedAt > existing.chat.updatedAt) {
      chatMap.set(bundle.chat.id, bundle);
    }
  }

  return {
    notes: dedupeByUpdatedAt(notes),
    tasks: dedupeByUpdatedAt(tasks),
    chats: [...chatMap.values()],
    tombstones,
    manifest,
    files,
    warnings,
  };
}

export function makeManifest(
  writerId: string,
  deviceName: string,
  notes: number,
  tasks: number,
  chats: number,
): StoreManifest {
  return {
    app: "lafei",
    format: "folder",
    version: 1,
    writerId,
    deviceName,
    updatedAt: Date.now(),
    counts: { notes, tasks, chats },
  };
}
