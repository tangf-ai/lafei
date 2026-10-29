import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { addTag, normalizeTag, removeTag, sameTag } from "../lib/tags";
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

/** 候选浮层：最大 / 最小高度，离窗口边缘的留白，和输入框的间距 */
const SUGGEST_MAX_HEIGHT = 240;
const SUGGEST_MIN_HEIGHT = 92;
const SUGGEST_GAP = 4;
const SUGGEST_EDGE = 8;
const SUGGEST_MIN_WIDTH = 176;
const SUGGEST_MAX_WIDTH = 360;
const SUGGEST_LIMIT = 60;

interface SuggestPlace {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "below" | "above";
}

/** 把标签名里和输入匹配的那一段挑出来，候选项里高亮 */
function withMatch(text: string, query: string) {
  if (!query) return text;
  const index = text.toLocaleLowerCase().indexOf(query);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="tag-suggest-mark">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}

/**
 * 笔记 / 任务共用的标签编辑器：已有标签以 #chip 展示，可删除、可继续添加。
 * 库里已有的标签通过自绘候选浮层提示：浮层挂在 body 上（不会被弹窗 / 浮层裁掉），
 * 空间不够时自动上翻，条目多时框内滚动，所以任何窗口高度下都能完整看到和支持键盘选择。
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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<SuggestPlace | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const query = normalizeTag(value).toLocaleLowerCase();
  const available = useMemo(
    () => suggestions.filter((tag) => !tags.some((item) => sameTag(item, tag))),
    [suggestions, tags],
  );
  const matches = useMemo(() => {
    if (!query) return available.slice(0, SUGGEST_LIMIT);
    return available.filter((tag) => tag.toLocaleLowerCase().includes(query)).slice(0, SUGGEST_LIMIT);
  }, [available, query]);

  useEffect(() => {
    if (!autoOpen) return;
    setAdding(true);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [autoOpen]);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  // 浮层位置：优先放下方，下方放不下就上翻；高度按可用空间收，超出在框内滚动
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const placeList = () => {
      const input = inputRef.current;
      const list = listRef.current;
      if (!input || !list) return;
      const rect = input.getBoundingClientRect();
      const width = Math.min(
        Math.max(rect.width, SUGGEST_MIN_WIDTH),
        SUGGEST_MAX_WIDTH,
        window.innerWidth - SUGGEST_EDGE * 2,
      );
      const left = Math.max(SUGGEST_EDGE, Math.min(rect.left, window.innerWidth - SUGGEST_EDGE - width));
      const natural = Math.min(list.scrollHeight, SUGGEST_MAX_HEIGHT);
      const spaceBelow = window.innerHeight - SUGGEST_EDGE - (rect.bottom + SUGGEST_GAP);
      const spaceAbove = rect.top - SUGGEST_GAP - SUGGEST_EDGE;
      const below = spaceBelow >= natural || spaceBelow >= spaceAbove;
      const maxHeight = Math.min(
        SUGGEST_MAX_HEIGHT,
        Math.max(SUGGEST_MIN_HEIGHT, below ? spaceBelow : spaceAbove),
      );
      const height = Math.min(natural, maxHeight);
      const top = below
        ? rect.bottom + SUGGEST_GAP
        : Math.max(SUGGEST_EDGE, rect.top - SUGGEST_GAP - height);
      setPlace({ left, top, width, maxHeight, placement: below ? "below" : "above" });
    };
    placeList();
    // 字体 / 内容可能晚一帧才撑开，再量一次
    const frame = window.requestAnimationFrame(placeList);
    const onMove = () => placeList();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, value, tags.length, matches.length]);

  const closeSuggest = () => {
    setOpen(false);
    setActive(-1);
  };

  /** 从候选里选一个标签，行为和回车提交一致 */
  const choose = (tag: string) => {
    const next = addTag(tags, tag, max);
    if (next !== tags) onChange(next);
    setValue("");
    setActive(-1);
    if (keepOpen) {
      setOpen(true);
      inputRef.current?.focus();
    } else {
      setAdding(false);
      setOpen(false);
    }
  };

  const commit = () => {
    if (value.trim()) {
      const next = addTag(tags, value, max);
      if (next !== tags) onChange(next);
    }
    setValue("");
    setActive(-1);
    if (!keepOpen) {
      setAdding(false);
      setOpen(false);
    } else {
      inputRef.current?.focus();
    }
  };

  const cancel = () => {
    setValue("");
    setAdding(false);
    setOpen(false);
    setActive(-1);
  };

  const showSuggest = open && (matches.length > 0 || Boolean(query));

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
        <input
          ref={inputRef}
          className="tag-input-field"
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSuggest}
          aria-controls={showSuggest ? `${listId}-list` : undefined}
          aria-activedescendant={showSuggest && active >= 0 ? `${listId}-opt-${active}` : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setActive(-1);
            commit();
          }}
          onKeyDown={(event) => {
            // 中文输入法选择候选词时的 Enter 不应该被当成“确认标签”
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const total = matches.length;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              if (total === 0) return;
              event.preventDefault();
              event.stopPropagation();
              const step = event.key === "ArrowDown" ? 1 : -1;
              if (!open) {
                setOpen(true);
                setActive(step > 0 ? 0 : total - 1);
                return;
              }
              setActive((current) => {
                if (current < 0) return step > 0 ? 0 : total - 1;
                return (current + step + total) % total;
              });
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              const picked = open && active >= 0 ? matches[active] : null;
              if (picked) choose(picked);
              else commit();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              // 有候选时先收候选，再按一次才取消输入
              if (open) {
                closeSuggest();
                return;
              }
              cancel();
              return;
            }
            if (event.key === "Tab") {
              closeSuggest();
              return;
            }
            if (event.key === "Backspace" && !value && tags.length > 0) {
              event.preventDefault();
              onChange(removeTag(tags, tags[tags.length - 1]));
            }
          }}
        />
      ) : (
        <button type="button" className="tag-chip-add" onClick={() => setAdding(true)}>
          <Plus size={11} /> {addLabel}
        </button>
      )}

      {showSuggest &&
        createPortal(
          <div
            ref={listRef}
            id={`${listId}-list`}
            className="tag-suggest"
            data-floating-layer="tag-suggest"
            data-placement={place?.placement ?? "below"}
            role="listbox"
            aria-label="已有标签"
            style={{
              left: place?.left ?? 0,
              top: place?.top ?? 0,
              width: place?.width ?? SUGGEST_MIN_WIDTH,
              maxHeight: place?.maxHeight ?? SUGGEST_MAX_HEIGHT,
              visibility: place ? "visible" : "hidden",
            }}
            // 保留输入框焦点，点候选时不会先触发 blur 提交
            onMouseDown={(event) => event.preventDefault()}
          >
            {matches.map((tag, index) => (
              <button
                key={tag}
                id={`${listId}-opt-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                className={cn("tag-suggest-item", index === active && "is-active")}
                title={`#${tag}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(tag)}
              >
                <span className="tag-suggest-hash" aria-hidden="true">
                  #
                </span>
                <span className="tag-suggest-label">{withMatch(tag, query)}</span>
              </button>
            ))}
            {matches.length === 0 && (
              <p className="tag-suggest-note">
                回车新建 <strong>#{normalizeTag(value) || value.trim()}</strong>
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
