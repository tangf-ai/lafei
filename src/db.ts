import Dexie, { type Table } from "dexie";
import type { Chat, ChatMessage, Note, Task, Tombstone } from "./types";
import { seedData } from "./lib/seed";
import { newId } from "./lib/util";

class LafeiDatabase extends Dexie {
  notes!: Table<Note, string>;
  tasks!: Table<Task, string>;
  chats!: Table<Chat, string>;
  messages!: Table<ChatMessage, string>;
  tombstones!: Table<Tombstone, string>;

  constructor() {
    super("lafei");
    this.version(1).stores({
      notes: "id, updatedAt, createdAt, pinned, *tags",
      tasks: "id, done, dueDate, updatedAt, noteId",
      chats: "id, updatedAt",
      messages: "id, chatId, createdAt",
    });
    this.version(2).stores({
      notes: "id, updatedAt, createdAt, pinned, *tags",
      tasks: "id, done, dueDate, updatedAt, noteId",
      chats: "id, updatedAt",
      messages: "id, chatId, createdAt",
      tombstones: "key, deletedAt",
    });
  }
}

export const db = new LafeiDatabase();

let bootstrapping: Promise<void> | null = null;

export function bootstrapDatabase() {
  if (bootstrapping) return bootstrapping;
  bootstrapping = (async () => {
    const seeded = localStorage.getItem("lafei:seeded:v1");
    const count = await db.notes.count();
    if (!seeded && count === 0) {
      const { notes, tasks } = seedData();
      await db.transaction("rw", db.notes, db.tasks, async () => {
        await db.notes.bulkAdd(notes);
        await db.tasks.bulkAdd(tasks);
      });
      localStorage.setItem("lafei:seeded:v1", "1");
    }
  })();
  return bootstrapping;
}

export async function createNote(partial: Partial<Note> = {}): Promise<Note> {
  const now = Date.now();
  const note: Note = {
    id: newId(),
    title: "",
    content: "",
    tags: [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
  await db.notes.add(note);
  return note;
}

export async function createTask(partial: Partial<Task> = {}): Promise<Task> {
  const now = Date.now();
  const task: Task = {
    id: newId(),
    title: "",
    description: "",
    noteId: null,
    dueDate: null,
    priority: "medium",
    done: false,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
  await db.tasks.add(task);
  return task;
}

export async function updateNote(id: string, patch: Partial<Note>) {
  await db.notes.update(id, { ...patch, updatedAt: Date.now() });
}

export async function updateTask(id: string, patch: Partial<Task>) {
  await db.tasks.update(id, { ...patch, updatedAt: Date.now() });
}

export async function toggleTask(task: Task) {
  await updateTask(task.id, {
    done: !task.done,
    completedAt: task.done ? null : Date.now(),
  });
}

export async function deleteNoteCascade(noteId: string) {
  await db.transaction("rw", db.notes, db.tasks, db.tombstones, async () => {
    const deletedAt = Date.now();
    await db.notes.delete(noteId);
    await db.tombstones.put({ key: `note:${noteId}`, kind: "note", id: noteId, deletedAt });
    const linked = await db.tasks.where("noteId").equals(noteId).toArray();
    await Promise.all(linked.map((task) => db.tasks.update(task.id, { noteId: null, updatedAt: Date.now() })));
  });
}

export async function deleteTask(id: string) {
  await db.transaction("rw", db.tasks, db.tombstones, async () => {
    await db.tasks.delete(id);
    await db.tombstones.put({ key: `task:${id}`, kind: "task", id, deletedAt: Date.now() });
  });
}

export async function deleteChatCascade(chatId: string) {
  await db.transaction("rw", db.chats, db.messages, db.tombstones, async () => {
    await db.messages.where("chatId").equals(chatId).delete();
    await db.chats.delete(chatId);
    await db.tombstones.put({ key: `chat:${chatId}`, kind: "chat", id: chatId, deletedAt: Date.now() });
  });
}
