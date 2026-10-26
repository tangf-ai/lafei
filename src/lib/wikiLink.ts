/**
 * 打开（或新建）一个 `[[双向链接]]` 目标笔记。
 *
 * 笔记正文的渲染层（lib/markdown.tsx）和即时预览编辑器都会用它，
 * 避免两处各写一份「找不到就创建」的逻辑。
 */
import { createNote, db } from "../db";
import { useUI, toast } from "../store/ui";
import { noteTitle } from "./util";

export async function openWikiLink(target: string): Promise<void> {
  const name = target.trim();
  if (!name) return;
  const notes = await db.notes.toArray();
  const existing = notes.find((note) => note.title.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    useUI.getState().openNote(existing.id);
    return;
  }
  const created = await createNote({ title: name });
  toast(`已创建「${noteTitle(created.title)}」`, "success");
  useUI.getState().openNote(created.id);
}
