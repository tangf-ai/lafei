import { useEffect, useRef, type ReactNode } from "react";

const modalStack: symbol[] = [];
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../lib/util";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  headless?: boolean;
  focusOnOpen?: boolean;
}

export function Modal({
  open,
  onClose,
  children,
  title,
  subtitle,
  size = "md",
  className,
  headless = false,
  focusOnOpen = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const stackId = useRef(Symbol("modal"));

  useEffect(() => {
    if (!open) return;
    const id = stackId.current;
    modalStack.push(id);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && modalStack[modalStack.length - 1] === id) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (focusOnOpen) {
      window.setTimeout(() => {
        const target = panelRef.current?.querySelector<HTMLElement>(
          "input:not([type=hidden]), textarea, select, [tabindex='0']",
        );
        target?.focus();
      }, 40);
    }
    return () => {
      const index = modalStack.lastIndexOf(id);
      if (index !== -1) modalStack.splice(index, 1);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose, focusOnOpen]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "对话框"}
        className={cn("modal", `modal-${size}`, className)}
      >
        {!headless && (
          <div className="modal-head">
            <div>
              {title && <h2 className="modal-title">{title}</h2>}
              {subtitle && <p className="modal-subtitle">{subtitle}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
