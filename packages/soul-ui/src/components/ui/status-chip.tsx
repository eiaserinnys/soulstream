import type { HTMLAttributes } from "react";
import "./status-chip.css";

export function StatusChip({ label, tone, className = "", ...props }: HTMLAttributes<HTMLSpanElement> & {
  label: string; tone?: string;
}) {
  return <span {...props} data-slot="status-chip" className={`v3-status-chip v3-status-chip--${tone ?? "open"} ${className}`.trim()}
    aria-label={label} title={label}>
    {tone ? <span className="v3-status-dot" aria-hidden="true" /> : null}
    <span className="v3-status-label">{label}</span>
  </span>;
}
