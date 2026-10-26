import { useEffect, useMemo, useRef } from "react";
import { extractOutline, type OutlineItem } from "../lib/outline";
import "./noteOutline.css";

/** 每级标题的缩进量（px）。 */
const INDENT_STEP = 13;

export function NoteOutline({
  content,
  onJump,
  activeIndex,
}: {
  content: string;
  onJump: (item: OutlineItem) => void;
  activeIndex?: number | null;
}) {
  const items = useMemo(() => extractOutline(content), [content]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 当前高亮项始终留在可视区域内（只滚动大纲自身，不打扰正文）
  useEffect(() => {
    if (activeIndex === null || activeIndex === undefined) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const active = scroller.querySelector<HTMLElement>(`[data-outline-index="${activeIndex}"]`);
    if (!active) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < scrollerRect.top) {
      scroller.scrollTop -= scrollerRect.top - activeRect.top + 4;
    } else if (activeRect.bottom > scrollerRect.bottom) {
      scroller.scrollTop += activeRect.bottom - scrollerRect.bottom + 4;
    }
  }, [activeIndex]);

  return (
    <nav className="note-outline" aria-label="笔记大纲">
      <h2 className="note-outline-title">大纲</h2>
      <div className="note-outline-scroll" ref={scrollRef}>
        {items.length === 0 ? (
          <p className="note-outline-empty">还没有标题</p>
        ) : (
          <ul className="note-outline-list">
            {items.map((item) => {
              const active = item.index === activeIndex;
              return (
                <li key={item.index}>
                  <button
                    type="button"
                    className={active ? "note-outline-item is-active" : "note-outline-item"}
                    data-outline-index={item.index}
                    data-level={item.level}
                    title={item.text}
                    aria-current={active ? "location" : undefined}
                    onClick={() => onJump(item)}
                  >
                    <span
                      className="note-outline-indent"
                      aria-hidden="true"
                      style={{ width: (item.level - 1) * INDENT_STEP }}
                    />
                    <span className="note-outline-label">{item.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
