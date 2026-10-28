import { useEffect, useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { addTag, removeTag, sameTag } from "../lib/tags";
import { cn } from "../lib/util";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  max?: number;
  placeholder?: string;
  compact?: boolean;
  /** 挂载后直接展开输入框，并聚焦 */
  autoOpen?: boolean;
  /** 点击已有标签时的动作；传入后标签文字变成按钮 */
  onTagClick?: (tag: string) => void;
  addLabel?: string;
  /** 提交一个标签后不收起输入框（浮层里连续添加时用） */
  keepOpen?: boolean;
  className?: string;
}

/**
 * 笔记 / 任务共用的标签编辑器：已有标签以 #chip 展示，可删除、可继续添加。
 * 支持用 <datalist> 提示库里已有的标签，避免同一个标签写出不同写法。
 */
export function TagInput({
  tags,
  onChange,
  suggestions = [],
  max,
  placeholder = "标签名",
  compact = false,
  autoOpen = false,
  onTagClick,
  addLabel = "标签",
  keepOpen = false,
  className,
}: TagInputProps) {
  const [adding, setAdding] = useState(Boolean(autoOpen));
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!autoOpen) return;
    setAdding(true);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [autoOpen]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const commit = () => {
    if (value.trim()) {
      const next = addTag(tags, value, max);
      if (next !== tags) onChange(next);
    }
    setValue("");
    if (!keepOpen) setAdding(false);
    else inputRef.current?.focus();
  };

  const cancel = () => {
    setValue("");
    setAdding(false);
  };

  const available = suggestions.filter((tag) => !tags.some((item) => sameTag(item, tag)));

  return (
    <div className={cn("tag-input", compact && "is-compact", className)}>
      {tags.map((tag) => (
        <span className="tag-chip" key={tag}>
          {onTagClick ? (
            <button
              type="button"
              className="tag-chip-label"
              onClick={() => onTagClick(tag)}
              title={`查看标签 #${tag}`}
            >
              #{tag}
            </button>
          ) : (
            <span className="tag-chip-label">#{tag}</span>
          )}
          <button
            type="button"
            className="tag-chip-remove"
            onClick={() => onChange(removeTag(tags, tag))}
            aria-label={`移除标签 ${tag}`}
          >
            <X size={10} />
          </button>
        </span>
      ))}

      {adding ? (
        <>
          <input
            ref={inputRef}
            className="tag-input-field"
            value={value}
            list={listId}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              // 中文输入法选择候选词时的 Enter 不应该被当成“确认标签”
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                commit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                cancel();
              } else if (event.key === "Backspace" && !value && tags.length > 0) {
                event.preventDefault();
                onChange(removeTag(tags, tags[tags.length - 1]));
              }
            }}
          />
          <datalist id={listId}>
            {available.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
              </option>
            ))}
          </datalist>
        </>
      ) : (
        <button type="button" className="tag-chip-add" onClick={() => setAdding(true)}>
          <Plus size={11} /> {addLabel}
        </button>
      )}
    </div>
  );
}
