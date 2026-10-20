export type Priority = "high" | "medium" | "low";
export type EntityKind = "note" | "task" | "chat";

export interface Tombstone {
  key: string;
  kind: EntityKind;
  id: string;
  deletedAt: number;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  noteId: string | null;
  dueDate: string | null;
  priority: Priority;
  done: boolean;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ChatRole = "user" | "assistant";

export interface ChatSource {
  id: string;
  title: string;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: ChatRole;
  content: string;
  sources: ChatSource[];
  createdAt: number;
}

export type AppView = "today" | "notes" | "tasks" | "assistant";
export type TaskFilter = "all" | "today" | "upcoming" | "done";
export type NoteMode = "write" | "split" | "read";
export type ThemeMode = "light" | "dark" | "system";
export type FontScale = 0.9 | 1 | 1.1 | 1.2;
export type AIProvider = "deepseek" | "openai" | "custom";

export interface AISettings {
  provider: AIProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LogseqTaskPreview {
  id: string;
  title: string;
  description: string;
  dueDate: string | null;
  priority: Priority;
  sourcePage: string;
  sourceFile: string;
  sourceLine: number;
  status: string;
}

export interface LogseqScan {
  graphPath: string;
  graphName: string;
  scannedFiles: number;
  openCount: number;
  completedCount: number;
  tasks: LogseqTaskPreview[];
}

export interface BackupData {
  app: "lafei";
  version: 1;
  exportedAt: string;
  notes: Note[];
  tasks: Task[];
  chats: Chat[];
  messages: ChatMessage[];
  tombstones?: Tombstone[];
}
