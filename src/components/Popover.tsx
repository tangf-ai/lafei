import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/util";
import { inFloatingLayer } from "../lib/floating";

interface PopoverProps {
  /** 触发浮层的元素（chip）；定位、点外关闭、焦点归还都以它为准 */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: number;
  label?: string;
  className?: string;
}

const EDGE = 12;
const GAP = 6;

/**
 * 锚在某个元素下方的小浮层（任务详情里的属性 chip 用）。
 * 只做三件事：定位（贴边 + 空间不够时上翻）、Esc / 点外关闭、↑↓ 在选项间移动焦点。
 * 层叠顺序介于弹窗（300）和 toast（500）之间；Esc 在捕获阶段拦下，避免把外层弹窗一起关掉。
 */
export function Popover({ anchor, open, onClose, children, width = 264, label, className }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const panel = panelRef.current;
      const panelWidth = Math.min(width, window.innerWidth - EDGE * 2);
      const panelHeight = panel?.offsetHeight ?? 0;
      const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - EDGE - panelWidth));
      let top = rect.bottom + GAP;
      if (panelHeight > 0 && top + panelHeight > window.innerHeight - EDGE) {
        const above = rect.top - GAP - panelHeight;
        top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - EDGE - panelHeight);
      }
      setPos({ left, top });
    };
    // 先量一次，字体/内容异步撑开后跟着量
    place();
    const timer = window.setTimeout(place, 30);
    // chip 加了标签会变长甚至换行，锚点尺寸一变就重新贴一次
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, width]);

  // 打开后把焦点交给浮层里的第一个控件
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const root = panelRef.current;
      const target = root?.querySelector<HTMLElement>("input:not([type=hidden]), button, [tabindex='0']");
      target?.focus();
    }, 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      // 从浮层里再弹出的候选（例如标签候选）也挂在 body 上，点它不算「点外面」
      if (inFloatingLayer(target)) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchor]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      className={cn("task-pop", className)}
      role="dialog"
      aria-label={label}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: `min(${width}px, calc(100vw - ${EDGE * 2}px))`,
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-pop-item]") ?? [])];
        if (items.length === 0) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = items[(current + step + items.length) % items.length];
        next?.focus();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
