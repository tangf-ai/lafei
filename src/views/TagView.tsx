import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCheck,
  FileText,
  ListTodo,
  Pin,
  Plus,
  Tag,
} from "lucide-react";
import { db, createNote, createTask } from "../db";
import { useUI } from "../store/ui";
import { cn, excerpt, noteTitle, updatedLabel } from "../lib/util";
import { collectTagCounts, hasTag, sameTag, tagsOf, type TagCount } from "../lib/tags";
import type { Task } from "../types";
import { TaskRow } from "../components/TaskRow";
import { EmptyState } from "../components/EmptyState";

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;

function sortOpenTasks(tasks: Task[]) {
  return tasks.slice().sort((a, b) => {
    const aDue = a.dueDate ?? "9999-12-31";
    const bDue = b.dueDate ?? "9999-12-31";
    if (aDue !== bDue) return aDue.localeCompare(bDue);
    return PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] || b.updatedAt - a.updatedAt;
  });
}

export function TagView() {
  const tagFilter = useUI((state) => state.tagFilter);
  const setTagFilter = useUI((state) => state.setTagFilter);
  const openTagView = useUI((state) => state.openTagView);
  const openNote = useUI((state) => state.openNote);
  const setView = useUI((state) => state.setView);
  const setTaskFilter = useUI((state) => state.setTaskFilter);
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);

  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const tasks = useLiveQuery(() => db.tasks.toArray(), [], []);

  const tagCounts = useMemo(() => collectTagCounts(notes, tasks), [notes, tasks]);
  const current = tagFilter ? tagCounts.find((item) => sameTag(item.tag, tagFilter)) : undefined;
  const activeTag = current?.tag ?? tagFilter ?? "";

  const taggedNotes = useMemo(
    () =>
      tagFilter
        ? notes
            .filter((note) => hasTag(note, tagFilter))
            .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
        : [],
    [notes, tagFilter],
  );
  const openTasks = useMemo(
    () =>
      tagFilter
        ? sortOpenTasks(tasks.filter((task) => !task.done && hasTag(task, tagFilter)))
        : [],
    [tasks, tagFilter],
  );
  const doneTasks = useMemo(
    () =>
      tagFilter
        ? tasks
            .filter((task) => task.done && hasTag(task, tagFilter))
            .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
        : [],
    [tasks, tagFilter],
  );
  const noteMap = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);

  const taggedOpenTaskCount = tasks.filter((task) => !task.done && tagsOf(task).length > 0).length;
  const taggedNoteCount = notes.filter((note) => tagsOf(note).length > 0).length;

  const createTaggedNote = async () => {
    if (!activeTag) return;
    const note = await createNote({ tags: [activeTag] });
    openNote(note.id);
  };

  const createTaggedTask = async () => {
    if (!activeTag) return;
    const task = await createTask({ title: "", dueDate: null, priority: "medium", tags: [activeTag] });
    setTaskDetailId(task.id);
  };

  if (!tagFilter) {
    return (
      <div className="view-scroll">
        <div className="page tags-page" data-tauri-drag-region>
          <header className="tags-header">
            <div className="tags-header-copy">
              <span className="eyebrow">Tags</span>
              <h1 className="tags-title display">按标签找回来。</h1>
              <p className="tags-subtitle">
                笔记和任务共用同一套标签。点一个标签，同时看到和它有关的两边内容。
              </p>
            </div>
            <div className="tags-stats">
              <div className="task-stat">
                <strong>{tagCounts.length}</strong>
                <span>标签</span>
              </div>
              <span className="task-stat-line" />
              <div className="task-stat">
                <strong>{taggedOpenTaskCount}</strong>
                <span>待办</span>
              </div>
              <span className="task-stat-line" />
              <div className="task-stat">
                <strong>{taggedNoteCount}</strong>
                <span>笔记</span>
              </div>
            </div>
          </header>

          {tagCounts.length ? (
            <div className="tag-index-grid">
              {tagCounts.map((item: TagCount) => (
                <button
                  key={item.tag}
                  type="button"
                  className="tag-index-card"
                  onClick={() => openTagView(item.tag)}
                >
                  <span className="tag-index-name">
                    <span className="tag-index-hash">#</span>
                    {item.tag}
                  </span>
                  <span className="tag-index-counts">
                    <span className={cn(item.openTasks > 0 && "is-strong")}>
                      {item.openTasks > 0 ? `${item.openTasks} 个待办` : `${item.tasks} 个任务`}
                    </span>
                    <span>{item.notes} 篇笔记</span>
                  </span>
                  <ArrowUpRight size={14} className="tag-index-arrow" />
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Tag size={26} />}
              title="还没有标签"
              description="在笔记或任务里加上第一个标签，它们会汇总在这里。"
              action={
                <button type="button" className="btn btn-primary" onClick={() => setView("notes")}>
                  <FileText size={15} /> 去写一篇笔记
                </button>
              }
            />
          )}
        </div>
      </div>
    );
  }

  const nothingHere = openTasks.length === 0 && doneTasks.length === 0 && taggedNotes.length === 0;

  return (
    <div className="view-scroll">
      <div className="page tags-page" data-tauri-drag-region>
        <header className="tag-detail-head">
          <div className="tag-detail-copy">
            <button type="button" className="btn btn-sm btn-ghost tag-back" onClick={() => setTagFilter(null)}>
              <ArrowLeft size={13} /> 全部标签
            </button>
            <span className="eyebrow">Tag</span>
            <h1 className="tag-detail-title display">
              <span className="tag-detail-hash">#</span>
              {activeTag}
            </h1>
            <p className="tag-detail-subtitle">
              {openTasks.length} 个待办 · {doneTasks.length} 个已完成 · {taggedNotes.length} 篇笔记
            </p>
          </div>
          <div className="tag-detail-actions">
            <button type="button" className="btn btn-sm btn-outline" onClick={() => void createTaggedNote()}>
              <FileText size={13} /> 新建笔记
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void createTaggedTask()}>
              <Plus size={13} /> 新建任务
            </button>
          </div>
        </header>

        {nothingHere ? (
          <EmptyState
            icon={<Tag size={26} />}
            title="这个标签下还没有内容"
            description="从标签页新建一篇笔记或一个任务，它们会自动带上这个标签。"
            action={
              <div className="tag-empty-actions">
                <button type="button" className="btn btn-primary" onClick={() => void createTaggedNote()}>
                  <FileText size={15} /> 新建笔记
                </button>
                <button type="button" className="btn btn-outline" onClick={() => void createTaggedTask()}>
                  <Plus size={15} /> 新建任务
                </button>
              </div>
            }
          />
        ) : (
          <>
            <section className="tag-section">
              <div className="tag-section-head">
                <h2 className="display">
                  <ListTodo size={16} /> 待办任务
                </h2>
                <span className="tag-section-count">{openTasks.length}</span>
                {openTasks.length > 0 && (
                  <button
                    type="button"
                    className="card-link"
                    onClick={() => {
                      setTaskFilter("all");
                      setView("tasks");
                      // setView 会清空标签筛选；这里显式保留，进入任务页后仍只看这个标签
                      setTagFilter(tagFilter);
                    }}
                  >
                    在任务页查看 <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
              {openTasks.length ? (
                <div className="tag-task-list">
                  {openTasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      note={task.noteId ? noteMap.get(task.noteId) : undefined}
                    />
                  ))}
                </div>
              ) : (
                <p className="tag-section-empty">这个标签下暂时没有待办任务。</p>
              )}
            </section>

            {doneTasks.length > 0 && (
              <details className="tag-done">
                <summary>
                  <CheckCheck size={14} /> 已完成 {doneTasks.length} 件
                  <span>展开看看做过的事</span>
                </summary>
                <div className="tag-task-list">
                  {doneTasks.slice(0, 30).map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      note={task.noteId ? noteMap.get(task.noteId) : undefined}
                      showCompletedAt
                    />
                  ))}
                </div>
              </details>
            )}

            <section className="tag-section">
              <div className="tag-section-head">
                <h2 className="display">
                  <FileText size={16} /> 相关笔记
                </h2>
                <span className="tag-section-count">{taggedNotes.length}</span>
                {taggedNotes.length > 0 && (
                  <button
                    type="button"
                    className="card-link"
                    onClick={() => {
                      setView("notes");
                      setTagFilter(tagFilter);
                    }}
                  >
                    在笔记页查看 <ArrowUpRight size={13} />
                  </button>
                )}
              </div>
              {taggedNotes.length ? (
                <div className="tag-note-grid">
                  {taggedNotes.map((note) => (
                    <div
                      key={note.id}
                      className="tag-note-card"
                      role="button"
                      tabIndex={0}
                      onClick={() => openNote(note.id, { keepTagFilter: true })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openNote(note.id, { keepTagFilter: true });
                        }
                      }}
                    >
                      <div className="tag-note-top">
                        <span>{updatedLabel(note.updatedAt)}</span>
                        {note.pinned && <Pin size={11} />}
                      </div>
                      <h3>{noteTitle(note.title)}</h3>
                      <p>{excerpt(note.content, 120) || "空白笔记"}</p>
                      <div className="tag-note-tags">
                        {tagsOf(note)
                          .filter((tag) => !sameTag(tag, activeTag))
                          .slice(0, 3)
                          .map((tag) => (
                            <span key={tag} className="tag-note-tag">
                              #{tag}
                            </span>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="tag-section-empty">这个标签下暂时没有笔记。</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
