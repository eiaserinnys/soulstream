import { REPORT_TIMELINE_STATUS_LABEL, type ReportTimelineRowLine } from "../../../packages/wire-schema/src/persistent_report";
import { StatusChip, useInternalLinkClick, type ReportTimelineAlignmentInset } from "@seosoyoung/soul-ui";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";

function isQuestionRow(line: ReportTimelineRowLine): boolean {
  return line.question_id !== undefined || line.status === "question"
    || line.status === "answered" || line.status === "withdrawn";
}

/** 카드 하나의 실제 상태를 그리는 일반 현황 줄인가. */
function isCardStatusRow(line: ReportTimelineRowLine): boolean {
  return line.card_id !== null && line.status !== "report" && !isQuestionRow(line);
}

/** 기록된 줄 대신 지금 카드 행의 상태·제목·상황을 보여 준다. */
function liveRow(line: ReportTimelineRowLine, card: CardRow): ReportTimelineRowLine {
  const status = card.status === "blocked" && card.blockedKind === "question" ? "question" : card.status;
  const detail = card.status === "done" || card.status === "cancelled" || card.status === "on_hold"
    ? ""
    : ((card.now?.turn === "user" && card.now.ask ? card.now.ask : card.now?.text) || card.blockedDetail || line.detail);
  return { ...line, status, title: card.title || line.title, detail };
}

export function ReportTimelineRow({
  line,
  alignmentInset,
}: {
  line: ReportTimelineRowLine;
  alignmentInset: ReportTimelineAlignmentInset;
}) {
  const internalLinkClick = useInternalLinkClick();
  const liveCard = useCardStore((state) => (line.card_id ? state.byId[line.card_id] : undefined));
  const shown = liveCard !== undefined && isCardStatusRow(line) ? liveRow(line, liveCard) : line;
  const content = <span
    className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap"
    data-slot="report-timeline-content"
  >
    <StatusChip
      className="shrink-0"
      label={REPORT_TIMELINE_STATUS_LABEL[shown.status]}
      {...(shown.status === "report" ? {} : { tone: shown.status })}
    />
    {shown.card_number !== null ? <span className="shrink-0 text-xs text-muted-foreground">#{shown.card_number}</span> : null}
    <span className="min-w-0 truncate text-xs text-foreground" data-slot="report-timeline-title">{shown.title}</span>
    {shown.detail ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" data-slot="report-timeline-detail">{shown.detail}</span> : null}
  </span>;
  const rowClassName = alignmentInset === "content"
    ? "flex min-w-0 py-1"
    : "flex min-w-0 gap-2 px-3 py-1";
  const rowContent = <>
    {alignmentInset === "avatar" ? <span aria-hidden="true" className="w-8 shrink-0" /> : null}
    {content}
  </>;

  return line.card_id ? <a
    className={`${rowClassName} rounded-floor text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background`}
    data-slot="report-timeline-row"
    href={`/?card=${encodeURIComponent(line.card_id)}`}
    onClick={internalLinkClick}
  >{rowContent}</a> : <div
    className={`${rowClassName} text-muted-foreground`}
    data-slot="report-timeline-row"
  >{rowContent}</div>;
}
