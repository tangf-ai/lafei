import { createPortal } from "react-dom";
import { Check, X, AlertCircle } from "lucide-react";
import { useToasts } from "../store/ui";

export function Toasts() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  if (!toasts.length) return null;
  return createPortal(
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <span className="toast-icon">
            {toast.tone === "success" ? <Check size={14} /> : toast.tone === "error" ? <AlertCircle size={14} /> : null}
          </span>
          <span>{toast.message}</span>
          <button type="button" className="toast-close" aria-label="关闭" onClick={() => dismiss(toast.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
