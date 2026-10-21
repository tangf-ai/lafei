import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CalendarDays, Check, Flag, Link2, Loader2, SquareArrowOutUpRight, Tag, Trash2 } from "lucide-react";
import { db, deleteTask, updateTask } from "../db";
import { useUI, toast } from "../store/ui";
import { cn, dueLabel, noteTitle } from "../lib/util";
import { collectTagCounts, tagsOf } from "../lib/tags";
import type { Priority, Task } from "../types";
import { Modal } from "./Modal";
import { ConfirmDialog } from "./ConfirmDialog";
import { TagInput } from "./TagInput";

const PRIORITIES: Array<{ id: Priority; label: string }> = [
  { id: "high", label: "高" },
  { id: "medium", label: "中" },
  { id: "low", label: "低" },
];

export function TaskDetailModal() {
  const taskId = useUI((state) => state.taskDetailId);
  const setTaskId = useUI((state) => state.setTaskDetailId);
  const openNote = useUI((state) => state.openNote);
  const openTagView = useUI((state) => state.openTagView);
  const task = useLiveQuery(() => (taskId ? db.tasks.get(taskId) : undefined), [taskId]);
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  const allTasks = useLiveQuery(() => db.tasks.toArray(), [], []);
  const tagSuggestions = useMemo(
    () => collectTagCounts(notes, allTasks).map((item) => item.tag),
    [allTasks, notes],
  );
  const [draft, setDraft] = useState<Task | null>(null);
  const [saved, setSaved] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirtyRef = useRef(false);
  const latestDraftRef = useRef<Task | null>(null);
  latestDraftRef.current = draft;

  const persist = async (value: Task) => {
    await updateTask(value.id, {
      title: value.title,
      description: value.description,
      noteId: value.noteId,
      dueDate: value.dueDate,
      priority: value.priority,
      tags: tagsOf(value),
      done: value.done,
      completedAt: value.completedAt,
    });
  };

  useEffect(() => {
    // 直接切到另一个任务时，先把上一个任务未落盘的改动画出来
    const previous = latestDraftRef.current;
    if (previous && previous.id !== task?.id && dirtyRef.current) {
      void persist(previous);
    }
    dirtyRef.current = false;
    if (task) {
      setDraft(task);
      setSaved(true);
    } else if (!task && taskId) {
      setDraft(null);
    }
  }, [task?.id]);

  useEffect(() => {
    if (!draft || !dirtyRef.current) return;
    setSaved(false);
    const timer = window.setTimeout(async () => {
      await persist(draft);
      if (latestDraftRef.current === draft) {
        dirtyRef.current = false;
        setSaved(true);
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [draft]);

  if (!taskId) return null;

  const patch = (value: Partial<Task>) => {
    dirtyRef.current = true;
    setDraft((current) => (current ? { ...current, ...value } : current));
  };

  const closeDetail = () => {
    if (draft && dirtyRef.current) {
      void persist(draft);
      dirtyRef.current = false;
    }
    setTaskId(null);
  };

  const toggleDone = () => {
    if (!draft) return;
    patch({ done: !draft.done, completedAt: draft.done ? null : Date.now() });
  };

  return (
    <>
      <Modal open={Boolean(taskId)} onClose={closeDetail} size="md" headless className="task-modal">
        {draft && (
          <div className="task-detail">
            <div className="task-detail-top">
              <button
                type="button"
                className={cn("task-check task-check-lg", draft.done && "is-done")}
                onClick={toggleDone}
                aria-label={draft.done ? "标记为未完成" : "标记为完成"}
              >
                {draft.done && <Check size={14} strokeWidth={3} />}
              </button>
              <span className="eyebrow">{draft.done ? "已完成" : "任务详情"}</span>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={closeDetail}
              >
                完成编辑
              </button>
            </div>

            <input
              className="task-detail-title"
              value={draft.title}
              onChange={(event) => patch({ title: event.target.value })}
              placeholder="任务是什么？"
              aria-label="任务标题"
            />

            <div className="task-detail-fields">
              <div className="task-field">
                <span className="task-field-label">
                  <CalendarDays size={14} /> 截止日期
                </span>
                <div className="task-field-control">
                  <input
                    type="date"
                    className="input input-date"
                    value={draft.dueDate ?? ""}
                    onChange={(event) => patch({ dueDate: event.target.value || null })}
                  />
                  {draft.dueDate && (
                    <span className={`pill pill-${dueLabel(draft.dueDate).tone}`}>{dueLabel(draft.dueDate).label}</span>
                  )}
                </div>
              </div>

              <div className="task-field">
                <span className="task-field-label">
                  <Flag size={14} /> 优先级
                </span>
                <div className="segmented segmented-sm">
                  {PRIORITIES.map((priority) => (
                    <button
                      key={priority.id}
                      type="button"
                      className={cn("segment", draft.priority === priority.id && "active", `priority-${priority.id}`)}
                      onClick={() => patch({ priority: priority.id })}
                    >
                      {priority.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="task-field task-field-wide">
                <span className="task-field-label">
                  <Tag size={14} /> 标签
                </span>
                <TagInput
                  tags={tagsOf(draft)}
                  suggestions={tagSuggestions}
                  onChange={(tags) => patch({ tags })}
                  onTagClick={(tag) => {
                    closeDetail();
                    openTagView(tag);
                  }}
                  placeholder="添加标签"
                />
              </div>

              <div className="task-field task-field-wide">
                <span className="task-field-label">
                  <Link2 size={14} /> 关联笔记
                </span>
                <div className="task-field-control">
                  <select
                    className="select"
                    value={draft.noteId ?? ""}
                    onChange={(event) => patch({ noteId: event.target.value || null })}
                  >
                    <option value="">不关联笔记</option>
                    {notes.map((note) => (
                      <option key={note.id} value={note.id}>
                        {noteTitle(note.title)}
                      </option>
                    ))}
                  </select>
                  {draft.noteId && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        setTaskId(null);
                        openNote(draft.noteId!);
                      }}
                    >
                      打开 <SquareArrowOutUpRight size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="task-detail-notes">
              <label className="field-label" htmlFor="task-description">
                备注
              </label>
              <textarea
                id="task-description"
                className="textarea"
                rows={3}
                placeholder="补充一些上下文、链接或下一步…"
                value={draft.description}
                onChange={(event) => patch({ description: event.target.value })}
              />
            </div>

            <div className="task-detail-foot">
              <span className="task-save-state">
                {saved ? (
                  <>
                    <Check size={13} /> 已自动保存
                  </>
                ) : (
                  <>
                    <Loader2 size={13} className="spin" /> 保存中…
                  </>
                )}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-ghost task-delete"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={14} /> 删除
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title="删除这个任务？"
        description="删除后无法恢复。关联的笔记不会被删除。"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (draft) {
            void deleteTask(draft.id);
            setTaskId(null);
            toast("任务已删除");
          }
        }}
      />
    </>
  );
}
