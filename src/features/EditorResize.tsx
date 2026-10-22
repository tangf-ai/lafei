import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";

/**
 * 笔记编辑器里的两个拖拽控件：
 * - ContentWidthHandle：拖动调整整体正文栏宽度（正文居中，左右两侧一起变宽）
 * - SplitDivider：分栏模式下左右两栏的宽度比例
 *
 * 两者都是受控组件：自身不保存宽度，只把手势换算成数值交给 onChange。
 * 定位、尺寸、外观全部交给 CSS（父级负责写入 --split-left 等变量）。
 */

/** 把数值夹在 [min, max] 之间 */
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** 拖动期间切换 body 光标并禁止选中文字，结束时必须恢复 */
function setBodyDragStyle(active: boolean) {
  document.body.style.cursor = active ? "col-resize" : "";
  document.body.style.userSelect = active ? "none" : "";
}

/** 卸载兜底：组件若在拖动中被移除，也要恢复 body 样式，避免光标卡在 col-resize */
function useBodyDragCleanup() {
  useEffect(() => () => setBodyDragStyle(false), []);
}

export interface ContentWidthHandleProps {
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
}

export function ContentWidthHandle({
  value,
  min,
  max,
  defaultValue,
  onChange,
}: ContentWidthHandleProps): ReactElement {
  const [dragging, setDragging] = useState(false);
  const activeRef = useRef(false);
  // 拖动起点在按下时固定；拖动过程中父级重渲染也只用 refs，不重新读取 props
  const startXRef = useRef(0);
  const startValueRef = useRef(0);
  const lastValueRef = useRef(0);

  useBodyDragCleanup();

  /** 按下：记录起点、捕获指针，后续 move/up 都会回到这个手柄上 */
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // preventDefault 会阻止默认聚焦，这里主动聚焦，拖动后可以直接用方向键微调
    event.currentTarget.focus({ preventScroll: true });
    const start = Math.round(clamp(value, min, max));
    activeRef.current = true;
    startXRef.current = event.clientX;
    startValueRef.current = start;
    lastValueRef.current = start;
    setDragging(true);
    setBodyDragStyle(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** 拖动：正文栏居中，左右两侧同时扩展，所以指针位移要乘 2 */
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    const next = clamp(startValueRef.current + (event.clientX - startXRef.current) * 2, min, max);
    const rounded = Math.round(next);
    if (rounded === lastValueRef.current) return;
    lastValueRef.current = rounded;
    onChange(rounded);
  };

  /** 结束（抬起 / 取消 / 丢失捕获）：清理拖动状态并提交最终值 */
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setDragging(false);
    setBodyDragStyle(false);
    onChange(clamp(lastValueRef.current, min, max));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /** 键盘微调：左右 ±32px，Home/End 跳到两端 */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -32 : 32;
      onChange(Math.round(clamp(value + delta, min, max)));
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(max);
    }
  };

  return (
    <div
      className="doc-width-handle"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-label="调整正文宽度"
      tabIndex={0}
      title="拖动调整正文宽度，双击恢复默认"
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={handleKeyDown}
    >
      <span className="doc-width-grip" aria-hidden="true" />
    </div>
  );
}

export interface SplitDividerProps {
  /** 左侧编辑区宽度比例 0..1 */
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (ratio: number) => void;
}

export function SplitDivider({
  value,
  min,
  max,
  defaultValue,
  onChange,
}: SplitDividerProps): ReactElement {
  const [dragging, setDragging] = useState(false);
  const activeRef = useRef(false);
  const lastRatioRef = useRef(clamp(value, min, max));

  useBodyDragCleanup();

  /** 用父容器（整个分栏区域）的矩形把指针位置换算成左侧宽度比例 */
  const ratioAt = (event: ReactPointerEvent<HTMLDivElement>): number | null => {
    const parent = event.currentTarget.parentElement;
    const rect = parent?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return clamp((event.clientX - rect.left) / rect.width, min, max);
  };

  /** 按下：沿用手柄当前位置作为起点，只捕获指针，不改变比例 */
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // 同 ContentWidthHandle：preventDefault 后手动聚焦，便于拖动后键盘微调
    event.currentTarget.focus({ preventScroll: true });
    activeRef.current = true;
    lastRatioRef.current = clamp(value, min, max);
    setDragging(true);
    setBodyDragStyle(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** 拖动：连续跟随指针，比例由父容器实时换算 */
  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    const ratio = ratioAt(event);
    if (ratio === null) return;
    lastRatioRef.current = ratio;
    onChange(ratio);
  };

  /** 结束（抬起 / 取消 / 丢失捕获）：恢复样式并提交最终比例 */
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setDragging(false);
    setBodyDragStyle(false);
    onChange(clamp(lastRatioRef.current, min, max));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /** 键盘微调：左右 ±0.02，Home/End 跳到两端 */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -0.02 : 0.02;
      onChange(clamp(value + delta, min, max));
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(max);
    }
  };

  return (
    <div
      className="split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100)}
      aria-label="调整分栏宽度"
      tabIndex={0}
      title="拖动调整左右宽度，双击回到 50 / 50"
      data-dragging={dragging ? "true" : undefined}
      data-left={Math.round(value * 100)}
      data-right={100 - Math.round(value * 100)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={handleKeyDown}
    >
      <span className="split-divider-grip" aria-hidden="true" />
    </div>
  );
}
