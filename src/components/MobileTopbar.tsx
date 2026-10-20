import { Search, Settings2 } from "lucide-react";
import { useUI } from "../store/ui";
import { shortDate } from "../lib/util";

export function MobileTopbar() {
  const setCommandOpen = useUI((state) => state.setCommandOpen);
  const setSettingsOpen = useUI((state) => state.setSettingsOpen);
  return (
    <header className="mobile-topbar">
      <div className="mobile-brand">
        <div className="brand-mark" aria-hidden="true">
          <span>l</span>
        </div>
        <span className="mobile-wordmark">
          lafei<span>.</span>
        </span>
      </div>
      <div className="mobile-topbar-actions">
        <span className="mobile-topbar-date">{shortDate()}</span>
        <button type="button" className="icon-btn" aria-label="搜索" onClick={() => setCommandOpen(true)}>
          <Search size={18} />
        </button>
        <button type="button" className="icon-btn" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Settings2 size={18} />
        </button>
      </div>
    </header>
  );
}
