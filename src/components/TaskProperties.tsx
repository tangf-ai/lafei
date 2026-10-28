import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarDays,
  Check,
  Flag,
  LayoutGrid,
  Link2,
  SquareArrowOutUpRight,
  Tag,
} from "lucide-react";
import type { Note, Priority, Task } from "../types";
import { cn, dateFromDayKey, noteTitle, remainingLabel, shortDate } from "../lib/util";
import { QUADRANTS, quadrantMeta, quadrantOf } from "../lib/quadrant";
import { tagsOf } from "../lib/tags";
import { DUE_PRESETS, duePresetDate } from "../lib/date";
import { TagInput } from "./TagInput";
import { Popover } from "./Popover";

type PropField = "due" | "priority" | "quadrant" | "tags" | "note";

const PRIORITY_OPTIONS: Array<{ id: Priority; label: string }> = [
  { id: "high", label: "高" },
  { id: "medium", label: "中" },
  { id: "low", label: "低" },
];

const MAX_VISIBLE_TAGS = 3;

interface TaskPropertiesProps {
  task: Task;
  notes: Note[];
  tagSuggestions: string[];
  patch: (value: Partial<Task>) => void;
  onOpenTag: (tag: string) => void;
  onOpenNote: (noteId: string) => void;
}

/** 日期 chip 的文案：日期 + 最近 7 天的相对提示（今天 / 明天 / 剩余 N 天 / 已逾期 N 天） */
function dueChipLabel(key: string | null) {
  if (!key) return null;
  const base = shortDate(dateFromDayKey(key));
  const rem = remainingLabel(key);
  if (rem.days === null) return { base, rel: null, tone: "none" as const };
  if (rem.days < 0) return { base, rel: rem.label, tone: "overdue" as const };
  if (rem.days === 0) return { base, rel: "今天", tone: "today" as const };
  if (rem.days === 1) return { base, rel: "明天", tone: "soon" as const };
  if (rem.days <= 7) return { base, rel: `剩余 ${rem.days} 天`, tone: "soon" as const };
  return { base, rel: null, tone: "none" as const };
}

interface ChipProps {
  icon: ReactNode;
  label: ReactNode;
  empty: boolean;
  open: boolean;
  ariaLabel: string;
  onClick: (element: HTMLButtonElement) => void;
}

function PropertyChip({ icon, label, empty, open, ariaLabel, onClick }: ChipProps) {
  return (
    <button
      type="button"
      className={cn("task-prop", empty && "is-empty", open && "is-open")}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={(event) => onClick(event.currentTarget)}
    >
      {icon}
      <span className="task-prop-text">{label}</span>
    </button>
  );
}

/**
 * 任务详情的属性条：截止日期 / 优先级 / 象限 / 标签 / 关联笔记收成一行 30px 的 chip，
 * 点开是浮层，浮层里就是原来的原生控件。空态虚线，已填态直接显示值。
 */
export function TaskProperties({
  task,
  notes,
  tagSuggestions,
  patch,
  onOpenTag,
  onOpenNote,
}: TaskPropertiesProps) {
  const [field, setField] = useState<PropField | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setField(null);
    setQuery("");
  }, [task.id]);

  const close = () => {
    setField(null);
    anchor?.focus();
  };

  const open = (next: PropField, element: HTMLElement) => {
    if (field === next) {
      close();
      return;
    }
    setAnchor(element);
    setField(next);
    setQuery("");
  };

  const tags = tagsOf(task);
  const due = dueChipLabel(task.dueDate);
  const quadrant = quadrantMeta(quadrantOf(task));
  const linkedNote = task.noteId ? notes.find((note) => note.id === task.noteId) ?? null : null;
  const filteredNotes = notes
    .filter((note) => {
      if (!query.trim()) return true;
      return noteTitle(note.title).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="task-props" role="group" aria-label="任务属性">
      <div className="task-props-bar">
        <PropertyChip
          open={field === "due"}
          empty={!task.dueDate}
          icon={<CalendarDays size={13} strokeWidth={1.7} />}
          ariaLabel={due ? `截止日期：${due.base}${due.rel ? `，${due.rel}` : ""}` : "设置截止日期"}
          onClick={(element) => open("due", element)}
          label={
            due ? (
              <>
                {due.base}
                {due.rel && (
                  <>
                    <span className="task-prop-sep">·</span>
                    <span className={cn("task-prop-rel", `is-${due.tone}`)}>{due.rel}</span>
                  </>
                )}
              </>
            ) : (
              "+ 日期"
            )
          }
        />

        <PropertyChip
          open={field === "priority"}
          empty={false}
          icon={<Flag size={13} strokeWidth={1.7} />}
          ariaLabel={`优先级：${PRIORITY_OPTIONS.find((item) => item.id === task.priority)?.label ?? "中"}`}
          onClick={(element) => open("priority", element)}
          label={
            <>
              <span className={cn("task-prop-dot", `is-${task.priority}`)} aria-hidden="true" />
              {PRIORITY_OPTIONS.find((item) => item.id === task.priority)?.label ?? "中"}
            </>
          }
        />

        <PropertyChip
          open={field === "quadrant"}
          empty={false}
          icon={<LayoutGrid size={13} strokeWidth={1.7} />}
          ariaLabel={`象限：${quadrant.title}`}
          onClick={(element) => open("quadrant", element)}
          label={quadrant.title}
        />

        <PropertyChip
          open={field === "tags"}
          empty={tags.length === 0}
          icon={<Tag size={13} strokeWidth={1.7} />}
          ariaLabel={tags.length > 0 ? `标签：${tags.join("、")}` : "添加标签"}
          onClick={(element) => open("tags", element)}
          label={
            tags.length > 0 ? (
              <span className="task-prop-tags">
                {tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
                  <span className="tag-chip" key={tag}>
                    <span className="tag-chip-label">#{tag}</span>
                  </span>
                ))}
                {tags.length > MAX_VISIBLE_TAGS && (
                  <span className="task-prop-more">+{tags.length - MAX_VISIBLE_TAGS}</span>
                )}
              </span>
            ) : (
              "+ 标签"
            )
          }
        />

        <PropertyChip
          open={field === "note"}
          empty={!linkedNote}
          icon={<Link2 size={13} strokeWidth={1.7} />}
          ariaLabel={linkedNote ? `关联笔记：${noteTitle(linkedNote.title)}` : "关联笔记"}
          onClick={(element) => open("note", element)}
          label={
            linkedNote ? (
              <span className="task-prop-note">{noteTitle(linkedNote.title)}</span>
            ) : (
              "+ 关联笔记"
            )
          }
        />
      </div>

      <Popover anchor={anchor} open={field === "due"} onClose={close} label="截止日期">
        <span className="task-pop-head">截止日期</span>
        <div className="task-pop-row">
          <input
            type="date"
            className="input input-date"
            value={task.dueDate ?? ""}
            aria-label="选择截止日期"
            onChange={(event) => patch({ dueDate: event.target.value || null })}
          />
        </div>
        <div className="task-pop-presets">
          {DUE_PRESETS.map((preset) => {
            const value = duePresetDate(preset.id);
            const active = (task.dueDate ?? null) === value;
            return (
              <button
                key={preset.id}
                type="button"
                data-pop-item
                className={cn("task-pop-preset", active && "is-active")}
                onClick={() => {
                  patch({ dueDate: value });
                  close();
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </Popover>

      <Popover anchor={anchor} open={field === "priority"} onClose={close} label="优先级" width={200}>
        <span className="task-pop-head">优先级</span>
        <div className="task-pop-list">
          {PRIORITY_OPTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-pop-item
              className={cn("task-pop-item", task.priority === item.id && "is-active")}
              onClick={() => {
                patch({ priority: item.id });
                close();
              }}
            >
              <span className={cn("task-prop-dot", `is-${item.id}`)} aria-hidden="true" />
              <span>{item.label}优先</span>
              {task.priority === item.id && <Check size={13} />}
            </button>
          ))}
        </div>
      </Popover>

      <Popover anchor={anchor} open={field === "quadrant"} onClose={close} label="象限" width={244}>
        <span className="task-pop-head">象限</span>
        <div className="task-pop-list">
          <button
            type="button"
            data-pop-item
            className={cn("task-pop-item", !task.quadrant && "is-active")}
            onClick={() => {
              patch({ quadrant: null });
              close();
            }}
          >
            <span>自动（按日期与优先级）</span>
            {!task.quadrant && <Check size={13} />}
          </button>
          {QUADRANTS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-pop-item
              className={cn("task-pop-item", task.quadrant === item.id && "is-active")}
              onClick={() => {
                patch({ quadrant: item.id });
                close();
              }}
            >
              <span className="task-pop-num">{item.num}</span>
              <span>{item.title}</span>
              {task.quadrant === item.id && <Check size={13} />}
            </button>
          ))}
        </div>
      </Popover>

      <Popover anchor={anchor} open={field === "tags"} onClose={close} label="标签">
        <span className="task-pop-head">标签</span>
        <TagInput
          tags={tags}
          suggestions={tagSuggestions}
          onChange={(next) => patch({ tags: next })}
          onTagClick={(tag) => {
            close();
            onOpenTag(tag);
          }}
          placeholder="标签名"
          addLabel="标签"
          autoOpen
          keepOpen
        />
      </Popover>

      <Popover anchor={anchor} open={field === "note"} onClose={close} label="关联笔记">
        <span className="task-pop-head">关联笔记</span>
        <input
          className="input task-pop-search"
          value={query}
          placeholder="搜索笔记…"
          aria-label="搜索笔记"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="task-pop-list is-scroll">
          <button
            type="button"
            data-pop-item
            className={cn("task-pop-item", !task.noteId && "is-active")}
            onClick={() => {
              patch({ noteId: null });
              close();
            }}
          >
            <span>不关联笔记</span>
            {!task.noteId && <Check size={13} />}
          </button>
          {filteredNotes.map((note) => (
            <button
              key={note.id}
              type="button"
              data-pop-item
              className={cn("task-pop-item", task.noteId === note.id && "is-active")}
              onClick={() => {
                patch({ noteId: note.id });
                close();
              }}
            >
              <span className="task-pop-note-name">{noteTitle(note.title)}</span>
              {task.noteId === note.id && <Check size={13} />}
            </button>
          ))}
          {filteredNotes.length === 0 && <p className="task-pop-empty">没有匹配的笔记</p>}
        </div>
        {linkedNote && (
          <div className="task-pop-foot">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => {
                close();
                onOpenNote(linkedNote.id);
              }}
            >
              打开笔记 <SquareArrowOutUpRight size={13} />
            </button>
          </div>
        )}
      </Popover>
    </div>
  );
}
