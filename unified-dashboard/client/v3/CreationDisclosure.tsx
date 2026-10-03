import { useEffect, useId, useState, type ReactNode } from "react";

/** Keep an invalid choice visible, and don't collapse the controls as it is corrected. */
export function CreationDisclosure({ title, summary, invalid = false, defaultExpanded = false, className = "v3-form-disclosure", children }: {
  title: string; summary: ReactNode; invalid?: boolean; defaultExpanded?: boolean; className?: string; children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded || invalid);
  const contentId = useId();
  useEffect(() => { if (invalid) setExpanded(true); }, [invalid]);
  return <details className={className} open={expanded || invalid}
    onToggle={event => {
      if (invalid && !event.currentTarget.open) event.currentTarget.open = true;
      setExpanded(event.currentTarget.open);
    }}>
    <summary aria-expanded={expanded || invalid} aria-controls={contentId} onClick={event => { if (invalid) event.preventDefault(); }}>
      <strong>{title}</strong><span>{summary}</span><span aria-hidden="true">{expanded || invalid ? "−" : "+"}</span>
      {invalid ? <span className="v3-form-selection-required">선택을 확인하세요</span> : null}
    </summary>
    <div id={contentId}>{children}</div>
  </details>;
}
