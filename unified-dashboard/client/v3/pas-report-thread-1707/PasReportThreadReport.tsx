import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Badge, Button, DashboardIconCap, Dialog, DialogPopup, DialogTitle, useIsMobile } from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, ExternalLink, PanelLeft, X } from "lucide-react";
import { DocumentReaderDialog } from "../DocumentReaderDialog";
import { CardWorkspace } from "../CardWorkspace";
import { reviewDetail } from "../components-review-fixtures";
import { dialoguesFolders } from "../dialogues-api";
import { StatusChip } from "../StatusChip";
import { EvidenceArt } from "./EvidenceArt";
import { PasThreadDecideBox, type DecisionTarget, type QuestionMode } from "./PasThreadDecideBox";
import { PasThreadRail } from "./PasThreadRail";
import { PasThreadTimeline } from "./PasThreadTimeline";
import {
  agendaStatusLabel,
  agendaStatusTone,
  taskCardsFor,
  type Agenda,
  type CheckItem,
  type DispositionId,
  type Evidence,
} from "./pas-report-thread-1707-data";

export type EvidenceView = { evidence: Evidence; trigger: HTMLElement | null } | null;

export function PasReportThreadReport({ agendas, activeId, open, onSelect, onClose, openTriggerRef, checks, questionAnswers,
  onToggleCheck, onInstruct, onChooseAnswer, target, onClearTarget, instruction, onChangeInstruction, onSendInstruction, onDispose, undoLabel, onUndo,
  evidenceView, onOpenEvidence, onCloseEvidence, documentId, onOpenDocument, onCloseDocument, onSnooze, onUnsnooze, onSimulate }: {
  agendas: readonly Agenda[];
  activeId: string;
  open: boolean;
  onSelect(id: string): void;
  onClose(): void;
  openTriggerRef: RefObject<HTMLButtonElement | null>;
  checks: Readonly<Record<string, boolean>>;
  questionAnswers: Readonly<Record<string, string | null>>;
  onToggleCheck(agendaId: string, checkId: string): void;
  onInstruct(agenda: Agenda, check: CheckItem): void;
  onChooseAnswer(agenda: Agenda, label: string): void;
  target: DecisionTarget;
  onClearTarget(): void;
  instruction: string;
  onChangeInstruction(value: string): void;
  onSendInstruction(mode: QuestionMode): void;
  onDispose(disposition: DispositionId): void;
  undoLabel: string | null;
  onUndo(): void;
  evidenceView: EvidenceView;
  onOpenEvidence(evidence: Evidence, trigger: HTMLElement | null): void;
  onCloseEvidence(): void;
  documentId: string | null;
  onOpenDocument(documentId: string): void;
  onCloseDocument(): void;
  onSnooze(label: string): void;
  onUnsnooze(): void;
  onSimulate(): void;
}) {
  const activeIndex = agendas.findIndex((agenda) => agenda.id === activeId);
  const agenda = agendas[Math.max(0, activeIndex)];
  const pending = agendas.filter((item) => item.status === "review" && !item.snoozedLabel);
  const pendingIndex = pending.findIndex((item) => item.id === agenda.id);
  const threadRef = useRef<HTMLDivElement>(null);
  const timelineWrapRef = useRef<HTMLDivElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const railTrigger = useRef<HTMLButtonElement>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusActiveRef = useRef(false);
  const pendingUndoFocusRef = useRef(false);
  const [railOpen, setRailOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const autoRef = useRef(true);
  const lastEvents = useRef({ id: agenda.id, count: agenda.events.length });
  const mobile = useIsMobile();
  const closeRail = () => {
    // Move focus before hiding the focused row so DialogPopup does not restore it to the popup.
    railTrigger.current?.focus({ preventScroll: true });
    setRailOpen(false);
  };
  const jump = () => {
    const scroll = threadRef.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    autoRef.current = true;
    setAutoScroll(true);
    setHasNew(false);
  };
  useLayoutEffect(() => {
    if (!open) return;
    lastEvents.current = { id: agenda.id, count: agenda.events.length };
    jump();
    const frame = requestAnimationFrame(() => {
      if (autoRef.current) jump();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, agenda.id]);
  useEffect(() => {
    const timeline = timelineWrapRef.current;
    if (!open || !timeline) return;
    const observer = new ResizeObserver(() => {
      const scroll = threadRef.current;
      if (scroll && autoRef.current) scroll.scrollTop = scroll.scrollHeight;
    });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [open, agenda.id]);
  useLayoutEffect(() => {
    if (!open) return;
    if (lastEvents.current.id === agenda.id && agenda.events.length > lastEvents.current.count) {
      if (autoRef.current) jump(); else setHasNew(true);
    }
    lastEvents.current = { id: agenda.id, count: agenda.events.length };
  }, [open, agenda.id, agenda.events.length]);
  useEffect(() => {
    if (!open) return;
    // 안쪽 창(증거 확대, 문서 열람)이 떠 있으면 Escape는 그 창만 닫는다. 두 창이 함께
    // 닫히면 문서를 읽던 자리와 보고 창을 모두 잃는다.
    const closeInner = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panelOpen) { event.preventDefault(); event.stopImmediatePropagation(); setPanelOpen(false); requestAnimationFrame(() => panelTrigger.current?.focus({ preventScroll: true })); return; }
      if (railOpen) { event.preventDefault(); event.stopImmediatePropagation(); closeRail(); return; }
      if (documentId) { event.preventDefault(); event.stopImmediatePropagation(); onCloseDocument(); return; }
      if (evidenceView) { event.preventDefault(); event.stopImmediatePropagation(); onCloseEvidence(); }
    };
    document.addEventListener("keydown", closeInner, true);
    return () => document.removeEventListener("keydown", closeInner, true);
  }, [open, documentId, evidenceView, panelOpen, railOpen, onCloseDocument, onCloseEvidence]);
  const go = (delta: number) => {
    const next = agendas[Math.min(agendas.length - 1, Math.max(0, activeIndex + delta))];
    if (next && next.id !== agenda.id) onSelect(next.id);
  };
  const card = taskCardsFor([agenda])[0];
  const detail = { ...reviewDetail, card: { ...card, folderId: dialoguesFolders[0].id },
    reports: [{ ...reviewDetail.reports[0], title: "결과 보고", body: agenda.kind === "ui"
      ? `${agenda.summary}\n\n변경 파일: 슬라이드 편집 화면과 저장 처리` : agenda.summary }] };
  const openPanel = (trigger: HTMLElement | null) => { panelTrigger.current = trigger; setPanelOpen(true); };
  const closePanel = () => { setPanelOpen(false); requestAnimationFrame(() => panelTrigger.current?.focus({ preventScroll: true })); };
  const activeRailItem = () => document.querySelector<HTMLElement>('.pas-rt1707-rail-item[data-active="true"]');
  const focusActive = () => activeRailItem()?.focus({ preventScroll: true });
  const runWithUndoFocus = (action: () => void) => {
    // A decision can remove or disable the pressed button; the undo button gets focus once it is committed.
    pendingFocusActiveRef.current = false;
    pendingUndoFocusRef.current = true;
    threadRef.current?.focus({ preventScroll: true });
    action();
  };
  useEffect(() => {
    if (!open || !undoLabel || !pendingUndoFocusRef.current) return;
    pendingUndoFocusRef.current = false;
    const focusUndo = () => undoButtonRef.current?.focus({ preventScroll: true });
    focusUndo();
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      focusUndo();
      secondFrame = requestAnimationFrame(focusUndo);
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [open, undoLabel, agenda.id]);
  const snooze = (label: string) => {
    const focusAnchor = mobile ? railTrigger.current : threadRef.current;
    focusAnchor?.focus({ preventScroll: true });
    if (!mobile) pendingFocusActiveRef.current = true;
    onSnooze(label);
  };
  useEffect(() => {
    if (!open || mobile || !pendingFocusActiveRef.current) return;
    pendingFocusActiveRef.current = false;
    // The active row is committed and the focused anchor stays mounted, so a later frame would only steal newer focus.
    focusActive();
  }, [open, mobile, agenda.id, agenda.snoozedLabel]);
  useEffect(() => {
    if (mobile && railOpen) requestAnimationFrame(() => activeRailItem()?.focus({ preventScroll: true }));
  }, [mobile, railOpen]);
  return <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup className="v3-surface pas-rt1707-dialog" showCloseButton={false} data-testid="pas-report-thread-dialog"
        initialFocus={() => mobile ? railTrigger.current : document.querySelector<HTMLElement>('[data-testid="pas-report-thread-dialog"] .pas-rt1707-rail-item[data-active="true"]')}
        finalFocus={() => openTriggerRef.current}
        onKeyDown={(event) => {
          const element = event.target as HTMLElement | null;
          if (event.key === "Tab" && mobile && railOpen) {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".pas-rt1707-report-head button:not(:disabled), .pas-rt1707-rail-item")].filter((item) => item.getClientRects().length > 0);
            const first = items[0], last = items.at(-1);
            if (event.shiftKey && element === first && last) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && element === last && first) { event.preventDefault(); first.focus(); }
          }
          if (element?.closest("input, textarea, [contenteditable='true'], [role='textbox']")) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
          if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
        }}>
        <header className="pas-rt1707-report-head">
          <div className="pas-rt1707-rail-toggle"><DashboardIconCap ref={railTrigger} size="small" appearance="bare" label="안건 목록"
            data-testid="pas-rt1707-rail-toggle" aria-expanded={railOpen} onClick={railOpen ? closeRail : () => setRailOpen(true)}><PanelLeft className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap></div>
          <div className="pas-rt1707-report-heading">
            <span className="pas-rt1707-report-number">#{agenda.number}</span>
            <DialogTitle className="pas-rt1707-report-title">{agenda.title}</DialogTitle>
            <StatusChip label={agendaStatusLabel(agenda)} tone={agendaStatusTone(agenda)} />
            {agenda.keptAsReference ? <Badge variant="info" size="sm">참고</Badge> : null}
          </div>
          <div className="pas-rt1707-report-tools">
            {pendingIndex >= 0 ? <span className="pas-rt1707-report-count" aria-label={`${pending.length}건 가운데 ${pendingIndex + 1}번째`}>{pendingIndex + 1} / {pending.length}</span> : null}
            <DashboardIconCap size="small" appearance="bare" label="이전 안건" disabled={activeIndex <= 0} onClick={() => go(-1)}><ChevronLeft className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
            <DashboardIconCap size="small" appearance="bare" label="다음 안건" disabled={activeIndex >= agendas.length - 1} onClick={() => go(1)}><ChevronRight className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
            <DashboardIconCap size="small" appearance="bare" label="카드 패널 열기" data-testid="pas-rt1707-open-card-panel" onClick={(event) => openPanel(event.currentTarget)}><ExternalLink className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
            <DashboardIconCap size="small" appearance="bare" label="보고 창 닫기" onClick={onClose}><X className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
          </div>
        </header>
        <div className="pas-rt1707-report-main" data-rail-open={railOpen || undefined}>
          {railOpen ? <button type="button" tabIndex={-1} className="pas-rt1707-rail-scrim" aria-label="안건 목록 닫기" onClick={closeRail} /> : null}
          <PasThreadRail agendas={agendas} activeId={agenda.id} onSelect={(id) => {
            if (railOpen) closeRail();
            if (!mobile) {
              if (id === agenda.id) focusActive();
              else pendingFocusActiveRef.current = true;
            }
            onSelect(id);
          }} />
          <div className="pas-rt1707-thread" inert={mobile && railOpen ? true : undefined}>
            <div className="pas-rt1707-thread-content">
            <div ref={threadRef} tabIndex={-1} className="pas-rt1707-thread-scroll" data-auto-scroll={autoScroll} onScroll={(event) => {
              const node = event.currentTarget;
              const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
              autoRef.current = atBottom; setAutoScroll(atBottom); if (atBottom) setHasNew(false);
            }}>
              <div ref={timelineWrapRef}>
                <PasThreadTimeline agenda={agenda} checks={checks} questionAnswer={questionAnswers[agenda.id] ?? null}
                  onToggleCheck={onToggleCheck} onInstruct={onInstruct} onOpenEvidence={onOpenEvidence} onOpenDocument={onOpenDocument} onOpenCard={openPanel} />
              </div>
            </div>
            {!autoScroll ? <Button className="pas-rt1707-jump" data-testid="pas-rt1707-jump-latest" onClick={() => { jump(); threadRef.current?.focus({ preventScroll: true }); }}>{hasNew ? "새 경과 ↓" : "최신 경과로 ↓"}</Button> : null}
            </div>
            <PasThreadDecideBox key={agenda.id} agenda={agenda} target={target} onClearTarget={onClearTarget} text={instruction}
              onChangeText={onChangeInstruction} onSend={onSendInstruction} onDispose={(disposition) => runWithUndoFocus(() => onDispose(disposition))}
              questionAnswer={questionAnswers[agenda.id] ?? null} onChooseQuestion={(label) => runWithUndoFocus(() => onChooseAnswer(agenda, label))}
              undoLabel={undoLabel} onUndo={onUndo} onSnooze={snooze} onUnsnooze={onUnsnooze} onSimulate={onSimulate} undoButtonRef={undoButtonRef} />
          </div>
        </div>
        {panelOpen ? <CardWorkspace cardId={agenda.id} sampleDetail={detail} folders={dialoguesFolders}
          onClose={closePanel} onOpenSession={() => undefined} mobileMode={mobile} mobileTab="today"
          activeSession={undefined} chatInputDisabled historyEnabled={false} sessionStreamActive={false} sessionConnectionStatus="disconnected"
          reconnectSession={() => undefined} onAcknowledgedReview={() => undefined} /> : null}
      </DialogPopup>
    </Dialog>
    <EvidenceDialog view={evidenceView} onClose={onCloseEvidence} />
    <DocumentReaderDialog documentId={documentId} onClose={onCloseDocument} />
  </>;
}

function EvidenceDialog({ view, onClose }: { view: EvidenceView; onClose(): void }) {
  return <Dialog open={view !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPopup className="v3-surface pas-rt1707-evidence-dialog" closeProps={{ "aria-label": "증거 닫기" }}
      finalFocus={() => view?.trigger ?? null} data-testid="pas-report-evidence-dialog">
      <div className="pas-rt1707-evidence-large">
        <DialogTitle className="pas-rt1707-evidence-title">{view?.evidence.label ?? "증거"}</DialogTitle>
        {view ? <EvidenceArt evidence={view.evidence} large /> : null}
        {view ? <p className="pas-rt1707-evidence-caption">{view.evidence.caption}</p> : null}
      </div>
    </DialogPopup>
  </Dialog>;
}
