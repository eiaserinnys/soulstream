import { createPortal } from "react-dom";
import type { CSSProperties, RefObject } from "react";
import { DashboardIconCap } from "@seosoyoung/soul-ui";
import type { PersistentSessionRect, PersistentSessionReportBubbleLayout } from "@seosoyoung/soul-ui/lib/persistent-session-layout";
import { ChevronLeft, ChevronRight, Maximize2 } from "lucide-react";
import { StatusChip } from "../StatusChip";
import { AGENDA_STATUS_LABEL, type Agenda } from "./pas-report-thread-1707-data";

export function PasReportBubble({ agenda, position, total, layout, body, target, inline, onOpen, onPrev, onNext, canPrev, canNext, openTriggerRef }: {
  agenda: Agenda;
  position: number;
  total: number;
  layout: PersistentSessionReportBubbleLayout | null;
  body: PersistentSessionRect | null;
  target: HTMLElement | null;
  inline: boolean;
  onOpen(): void;
  onPrev(): void;
  onNext(): void;
  canPrev: boolean;
  canNext: boolean;
  openTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const bubble = <article className="pas-report pas-rt1707-bubble" data-bubble={inline ? undefined : "true"} data-testid="pas-report-bubble">
    <div className="pas-report-sheet">
      <div className="pas-report-content">
        <div className="pas-report-heading">
          <div className="pas-report-heading-main">
            <span className="pas-report-card">#{agenda.number}</span>
            <StatusChip label={AGENDA_STATUS_LABEL[agenda.status]} tone={agenda.status} />
            <button type="button" className="pas-report-title pas-rt1707-bubble-title" onClick={onOpen}
              aria-label={`${agenda.number}번 보고 창 열기`}>{agenda.title}</button>
          </div>
        </div>
        <p className="pas-report-context">{agenda.summary}</p>
      </div>
      <div className="pas-rt1707-bubble-foot">
        <div className="pas-rt1707-bubble-nav">
          <DashboardIconCap size="small" appearance="bare" label="이전 안건" disabled={!canPrev} onClick={onPrev}><ChevronLeft className="size-4" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
          <span className="pas-report-count">{total === 0 ? "0 / 0" : `${position} / ${total}`}</span>
          <DashboardIconCap size="small" appearance="bare" label="다음 안건" disabled={!canNext} onClick={onNext}><ChevronRight className="size-4" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
        </div>
        <div className="pas-rt1707-bubble-actions">
          <button ref={openTriggerRef} type="button" className="pas-rt1707-open-report" onClick={onOpen}>보고 창 열기</button>
          <DashboardIconCap size="small" appearance="bare" label="보고 창 크게 열기" onClick={onOpen}><Maximize2 className="size-4" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
        </div>
      </div>
    </div>
    {!inline && layout ? <span className="pas-report-tail" data-direction={layout.tailDirection}
      style={{ "--pas-report-tail-left": `${layout.tailLeft}px` } as CSSProperties} aria-hidden="true" /> : null}
  </article>;

  if (inline || !layout || !body || !target) return bubble;
  const style: CSSProperties = {
    position: "absolute",
    left: layout.left - body.left,
    top: layout.bottom - body.top,
    width: layout.width,
    transform: "translateY(-100%)",
  };
  return createPortal(<div className="pas-rt1707-bubble-seat" style={style}>{bubble}</div>, target);
}
