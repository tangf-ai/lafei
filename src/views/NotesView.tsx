import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowUpRight, FileText, PanelLeftClose, PanelLeftOpen, Pin, Plus, Search, X } from "lucide-react";
import { db } from "../db";
import { useUI } from "../store/ui";
import { useIsMobile } from "../lib/hooks";
import { searchNotes } from "../lib/search";
import { hasTag, sameTag, tagsOf } from "../lib/tags";
import { cn, noteTitle, updatedLabel } from "../lib/util";
import { newNote } from "../lib/actions";
import { NoteEditor } from "./NoteEditor";
import { EmptyState } from "../components/EmptyState";

export function NotesView() {
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const activeNoteId = useUI((state) => state.activeNoteId);
  const openNote = useUI((state) => state.openNote);
  const closeNote = useUI((state) => state.closeNote);
  const tagFilter = useUI((state) => state.tagFilter);
  const setTagFilter = useUI((state) => state.setTagFilter);
  const isMobile = useIsMobile();
  const notesListCollapsed = useUI((state) => state.notesListCollapsed);
  const setNotesListCollapsed = useUI((state) => state.setNotesListCollapsed);
  const listCollapsed = !isMobile && notesListCollapsed;
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const base = tagFilter ? notes.filter((note) => hasTag(note, tagFilter)) : notes;
    return searchNotes(base, query);
  }, [notes, query, tagFilter]);

  useEffect(() => {
    if (!isMobile && !activeNoteId && filtered.length > 0) {
      openNote(filtered[0].id, { keepTagFilter: true });
    }
  }, [activeNoteId, filtered, isMobile, openNote]);

  const tagCounts = useMemo(() => {
    // 和标签页保持一致：大小写不同的同名标签合并展示
    const counts = new Map<string, { tag: string; count: number }>();
    for (const note of notes) {
      for (const tag of tagsOf(note)) {
        const key = tag.toLocaleLowerCase();
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { tag, count: 1 });
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "zh"))
      .slice(0, 10)
      .map((entry) => [entry.tag, entry.count] as const);
  }, [notes]);

  useEffect(() => {
    setQuery("");
  }, [tagFilter]);

  useEffect(() => {
    if (isMobile || !tagFilter || !activeNoteId) return;
    const current = notes.find((note) => note.id === activeNoteId);
    if (!current || hasTag(current, tagFilter)) return;
    const first = notes
      .filter((note) => hasTag(note, tagFilter))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)[0];
    if (first) openNote(first.id, { keepTagFilter: true });
    else closeNote();
  }, [activeNoteId, closeNote, isMobile, notes, openNote, tagFilter]);

  useEffect(() => {
    if (activeNoteId && notes.length > 0 && !notes.some((note) => note.id === activeNoteId)) {
      closeNote();
    }
  }, [activeNoteId, closeNote, notes]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        if (useUI.getState().view !== "notes") return;
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const showListOnMobile = !activeNoteId;
  const showEditorOnMobile = Boolean(activeNoteId);

  return (
    <div className={cn("notes-layout", listCollapsed && "is-list-collapsed")}>
      <aside className={cn("notes-list-pane", !showListOnMobile && "mobile-hidden")}>
        <div className="notes-list-head" data-tauri-drag-region>
          <div className="notes-list-heading">
            <div>
              <span className="eyebrow">知识库</span>
              <h1 className="notes-heading-title">
                {tagFilter ? (
                  <span className="notes-heading-tag">
                    #{tagFilter}
                    <button type="button" className="icon-btn icon-btn-sm" onClick={() => setTagFilter(null)} aria-label="清除标签">
                      <X size={13} />
                    </button>
                  </span>
                ) : (
                  "所有笔记"
                )}
              </h1>
            </div>
            <div className="notes-list-head-actions">
              {!isMobile && (
                <button
                  type="button"
                  className="icon-btn notes-list-collapse"
                  onClick={() => setNotesListCollapsed(true)}
                  title="收起笔记列表"
                  aria-label="收起笔记列表"
                >
                  <PanelLeftClose size={16} />
                </button>
              )}
              <button type="button" className="notes-new-btn" onClick={() => void newNote()} aria-label="新建笔记">
                <Plus size={18} />
              </button>
            </div>
          </div>

          <div className="search-field">
            <Search size={15} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、正文或标签"
              aria-label="搜索笔记"
            />
            {query ? (
              <button type="button" className="icon-btn icon-btn-sm" onClick={() => setQuery("")} aria-label="清除搜索">
                <X size={13} />
              </button>
            ) : (
              <span className="kbd">⌘F</span>
            )}
          </div>

          <div className="notes-list-meta">
            <span>{filtered.length} 篇笔记</span>
            <span className="notes-sort-label">按最近编辑</span>
          </div>

          {tagCounts.length > 0 && (
            <div className="mobile-tag-strip" aria-label="按标签筛选">
              <button
                type="button"
                className={!tagFilter ? "mobile-tag-pill active" : "mobile-tag-pill"}
                onClick={() => setTagFilter(null)}
              >
                全部
              </button>
              {tagCounts.map(([tag, count]) => (
                <button
                  key={tag}
                  type="button"
                  className={tagFilter !== null && sameTag(tagFilter, tag) ? "mobile-tag-pill active" : "mobile-tag-pill"}
                  onClick={() => setTagFilter(tag)}
                >
                  #{tag}
                  <span>{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="notes-list-scroll">
          {filtered.length === 0 ? (
            <div className="notes-list-empty">
              <FileText size={22} />
              <p>{query ? "没有匹配的笔记" : tagFilter ? "这个标签下还没有笔记" : "还没有笔记"}</p>
              <button type="button" className="btn btn-sm btn-outline" onClick={() => void newNote()}>
                <Plus size={14} /> 新建一篇
              </button>
            </div>
          ) : (
            filtered.map((note) => (
              <button
                key={note.id}
                type="button"
                className={cn("note-list-item", activeNoteId === note.id && "is-active")}
                onClick={() => openNote(note.id, { keepTagFilter: Boolean(tagFilter) })}
              >
                <div className="note-item-top">
                  <span className="note-item-date">{updatedLabel(note.updatedAt)}</span>
                  {note.pinned && <Pin size={12} className="note-pin" />}
                </div>
                <h2 className="note-item-title">{noteTitle(note.title)}</h2>
                <p className="note-item-excerpt">{note.snippet || "空白笔记，等你写下第一句。"}</p>
                {note.tags.length > 0 && (
                  <div className="note-item-tags">
                    {note.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="note-item-tag">
                        #{tag}
                      </span>
                    ))}
                    {note.tags.length > 3 && <span className="note-item-tag">+{note.tags.length - 3}</span>}
                  </div>
                )}
              </button>
            ))
          )}
        </div>

        <div className="notes-list-foot">
          <span>
            <span className="local-dot" /> 随时自动保存
          </span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void newNote()}>
            <Plus size={13} /> 新建
          </button>
        </div>
      </aside>

      {activeNoteId ? (
        <NoteEditor noteId={activeNoteId} key={activeNoteId} />
      ) : (
        <section className={cn("notes-empty-pane", showEditorOnMobile && "mobile-hidden")}>
          <EmptyState
            icon={<FileText size={26} />}
            title="从一个念头开始"
            description="选中左侧的笔记，或新建一篇。支持 Markdown、双向链接，以及随时唤出的 AI。"
            action={
              <div className="notes-empty-actions">
                <button type="button" className="btn btn-primary" onClick={() => void newNote()}>
                  <Plus size={15} /> 新建笔记
                </button>
                {listCollapsed && (
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setNotesListCollapsed(false)}
                  >
                    <PanelLeftOpen size={15} /> 展开笔记列表
                  </button>
                )}
              </div>
            }
            footnote={
              <span className="notes-empty-foot">
                试试在正文里写 <code>[[笔记标题]]</code> 建立连接 <ArrowUpRight size={12} />
              </span>
            }
          />
        </section>
      )}
    </div>
  );
}
