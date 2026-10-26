export type Priority = "high" | "medium" | "low";
/** 四象限：q1 重要紧急 / q2 重要不紧急 / q3 紧急不重要 / q4 不重要不紧急 */
export type Quadrant = "q1" | "q2" | "q3" | "q4";
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
  tags: string[];
  /** 手动归到的象限；null / 缺省时按「截止日期 + 优先级」自动落位 */
  quadrant?: Quadrant | null;
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

export type AppView = "today" | "notes" | "tasks" | "tags" | "assistant";
export type TaskFilter = "all" | "today" | "upcoming" | "done";
/** 任务页主区的呈现方式 */
export type TaskViewMode = "list" | "matrix" | "calendar";
/** 笔记编辑器视图：即时预览（Markdown 自动渲染）/ 源码 / 分栏 / 阅读 */
export type NoteMode = "live" | "source" | "split" | "read";
export type ThemeMode = "light" | "dark" | "system" | "sunny" | "mint" | "sea";
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
