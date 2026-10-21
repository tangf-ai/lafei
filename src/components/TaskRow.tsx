import { Check, FileText } from "lucide-react";
import type { Note, Task } from "../types";
import { cn, dueLabel, isOverdue, noteTitle, remainingLabel } from "../lib/util";
import { toggleTask } from "../db";
import { useUI } from "../store/ui";

export function TaskRow({
  task,
  note,
  showNote = true,
  compact = false,
}: {
  task: Task;
  note?: Note;
  showNote?: boolean;
  compact?: boolean;
}) {
  const setTaskDetailId = useUI((state) => state.setTaskDetailId);
  const openNote = useUI((state) => state.openNote);
  const due = dueLabel(task.dueDate);
  const remaining = remainingLabel(task.dueDate);
  const overdue = !task.done && isOverdue(task.dueDate);

  return (
    <div
      className={cn("task-row", task.done && "is-done", overdue && "is-overdue", compact && "is-compact")}
      role="button"
      tabIndex={0}
      onClick={() => setTaskDetailId(task.id)}
      onKeyDown={(event) => {
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
          {task.priority === "high" && <span className="task-priority">高优先</span>}
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

      {task.priority !== "medium" && (
        <span className={cn("priority-flag", `priority-${task.priority}`)} title={`${task.priority === "high" ? "高" : "低"}优先级`} />
      )}
    </div>
  );
}
