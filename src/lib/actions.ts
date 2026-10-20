import type { Note, Task } from "../types";
import { createNote, createTask } from "../db";
import { useUI } from "../store/ui";

export async function newNote(partial: Partial<Note> = {}) {
  const note = await createNote(partial);
  useUI.getState().openNote(note.id);
  return note;
}

export async function newTask(partial: Partial<Task> = {}, openDetail = false) {
  const task = await createTask(partial);
  useUI.getState().setTaskFilter("all");
  useUI.getState().setView("tasks");
  if (openDetail) useUI.getState().setTaskDetailId(task.id);
  return task;
}
