import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
  footnote,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h2 className="empty-title display">{title}</h2>
      <p className="empty-description">{description}</p>
      {action && <div className="empty-action">{action}</div>}
      {footnote && <div className="empty-footnote">{footnote}</div>}
    </div>
  );
}
