import type { Note, Task } from "../types";
import { excerpt, stripMarkdown } from "./util";
import { tagsOf } from "./tags";

export interface NoteHit extends Note {
  score: number;
  snippet: string;
}

export function searchNotes(notes: Note[], rawQuery: string): NoteHit[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return notes
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map((note) => ({ ...note, score: 0, snippet: excerpt(note.content, 110) }));
  }
  const terms = Array.from(new Set([query, ...query.split(/\s+/).filter(Boolean)]));
  return notes
    .map((note) => {
      const title = note.title.toLowerCase();
      const content = note.content.toLowerCase();
      const tags = note.tags.join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 60;
        if (tags.includes(term)) score += 30;
        if (content.includes(term)) score += 8;
      }
      if (note.pinned) score += 2;
      return { ...note, score, snippet: bestSnippet(note, terms) };
    })
    .filter((note) => note.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
}

function bestSnippet(note: Note, terms: string[]) {
  const text = stripMarkdown(note.content);
  const lower = text.toLowerCase();
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1) {
      const start = Math.max(0, index - 34);
      const end = Math.min(text.length, index + term.length + 70);
      return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    }
  }
  return excerpt(note.content, 110);
}

export function searchTasks(tasks: Task[], rawQuery: string) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const terms = Array.from(new Set([query, ...query.split(/\s+/).filter(Boolean)]));
  return tasks
    .map((task) => {
      const title = task.title.toLowerCase();
      const description = task.description.toLowerCase();
      const tags = tagsOf(task).join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 60;
        if (tags.includes(term)) score += 30;
        if (description.includes(term)) score += 8;
      }
      return { task, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || b.task.updatedAt - a.task.updatedAt)
    .map((hit) => hit.task);
}
