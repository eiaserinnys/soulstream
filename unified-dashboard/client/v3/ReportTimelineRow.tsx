import { REPORT_TIMELINE_STATUS_LABEL, useInternalLinkClick } from "@seosoyoung/soul-ui";
import type { ReportTimelineAlignmentInset, ReportTimelineLine } from "@seosoyoung/soul-ui";
import { StatusChip } from "./StatusChip";

export function ReportTimelineRow({
  line,
  alignmentInset,
}: {
  line: ReportTimelineLine;
  alignmentInset: ReportTimelineAlignmentInset;
}) {
  const internalLinkClick = useInternalLinkClick();
  const content = <span
    className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap"
    data-slot="report-timeline-content"
  >
    <StatusChip
      className="shrink-0"
      label={REPORT_TIMELINE_STATUS_LABEL[line.status]}
      {...(line.status === "report" ? {} : { tone: line.status })}
    />
    {line.card_number !== null ? <span className="shrink-0 text-xs text-foreground">#{line.card_number}</span> : null}
    <span className="min-w-0 flex-1 truncate text-xs text-foreground" data-slot="report-timeline-title">{line.title}</span>
    {line.detail ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-slot="report-timeline-detail">{line.detail}</span> : null}
  </span>;
  const rowClassName = alignmentInset === "content"
    ? "flex min-w-0 py-1"
    : "flex min-w-0 gap-2 px-3 py-1";
  const rowContent = <>
    {alignmentInset === "avatar" ? <span aria-hidden="true" className="w-8 shrink-0" /> : null}
    {content}
  </>;

  return line.card_id ? <a
    className={`${rowClassName} rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background`}
    data-slot="report-timeline-row"
    href={`/?card=${encodeURIComponent(line.card_id)}`}
    onClick={internalLinkClick}
  >{rowContent}</a> : <div
    className={`${rowClassName} text-muted-foreground`}
    data-slot="report-timeline-row"
  >{rowContent}</div>;
}
