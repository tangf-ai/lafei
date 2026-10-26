import { Check, FileText } from "lucide-react";
import { format } from "date-fns";
import type { Note, Task } from "../types";
import { cn, dueLabel, isOverdue, noteTitle, remainingLabel } from "../lib/util";
import { tagsOf } from "../lib/tags";
import { toggleTask } from "../db";
import { useUI } from "../store/ui";

export function TaskRow({
  task,
  note,
  showNote = true,
  compact = false,
  showCompletedAt = false,
  inline = false,
  maxTags = 2,
}: {
  task: Task;
  note?: Note;
  showNote?: boolean;
  compact?: boolean;
  showCompletedAt?: boolean;
  inline?: boolean;
  /** 行内最多显示几个标签，超出显示 +N */
  maxTags?: number;
}) {
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);
  const openNote = useUI((state) => state.openNote);
  const openTagView = useUI((state) => state.openTagView);
  const due = dueLabel(task.dueDate);
  const remaining = remainingLabel(task.dueDate);
  const overdue = !task.done && isOverdue(task.dueDate);
  const tags = tagsOf(task);

  return (
    <div
      className={cn(
        "task-row",
        task.done && "is-done",
        overdue && "is-overdue",
        compact && "is-compact",
        inline && "is-inline",
      )}
      data-priority={task.priority}
      role="button"
      tabIndex={0}
      onClick={() => setTaskDetailId(task.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setTaskDetailId(task.id);
        }
      }}
    >
      <button
        type="button"
        className={cn("task-check", task.done && "is-done")}
        aria-label={task.done ? "标记为未完成" : "标记为完成"}
        onClick={(event) => {
          event.stopPropagation();
          void toggleTask(task);
        }}
      >
        {task.done && <Check size={11} strokeWidth={3.2} />}
      </button>

      <div className="task-row-main">
        <span className="task-row-title">{task.title || "未命名任务"}</span>
        <div className="task-row-meta">
          {showCompletedAt && task.done ? (
            <span className="task-due tone-none">
              完成于 {format(new Date(task.completedAt ?? task.updatedAt), "HH:mm")}
            </span>
          ) : (
            <>
              {task.dueDate && (
                <span className={cn("task-due", `tone-${due.tone}`)}>
                  {overdue && <span className="overdue-dot" />}
                  {due.label}
                </span>
              )}
              {!task.dueDate && <span className="task-due tone-none">待安排</span>}
              {task.dueDate && remaining.days !== null && remaining.days > 0 && (
                <span className={cn("task-remaining", `tone-${remaining.tone}`)}>{remaining.label}</span>
              )}
            </>
          )}
          {task.priority === "high" && <span className="task-priority">高优先</span>}
          {tags.length > 0 && (
            <span className="task-row-tags">
              {tags.slice(0, maxTags).map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="task-tag"
                  title={`按标签查看 #${tag}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    openTagView(tag);
                  }}
                >
                  #{tag}
                </button>
              ))}
              {tags.length > maxTags && <span className="task-tag is-more">+{tags.length - maxTags}</span>}
            </span>
          )}
          {showNote && note && (
            <button
              type="button"
              className="task-note-link"
              title={`打开笔记：${noteTitle(note.title)}`}
              onClick={(event) => {
                event.stopPropagation();
                openNote(note.id);
              }}
            >
              <FileText size={11} />
              <span>{noteTitle(note.title)}</span>
            </button>
          )}
        </div>
      </div>

      <span
        className={cn("priority-flag", `priority-${task.priority}`)}
        title={`${task.priority === "high" ? "高" : task.priority === "low" ? "低" : "中"}优先级`}
      />
    </div>
  );
}
