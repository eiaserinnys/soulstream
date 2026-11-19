import { useEffect, useRef, type RefObject } from "react";
import { Badge, DashboardIconCap, Dialog, DialogPopup, DialogTitle } from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { DocumentReaderDialog } from "../DocumentReaderDialog";
import { StatusChip } from "../StatusChip";
import { EvidenceArt } from "./EvidenceArt";
import { PasThreadDecideBox, type DecisionTarget } from "./PasThreadDecideBox";
import { PasThreadRail } from "./PasThreadRail";
import { PasThreadTimeline } from "./PasThreadTimeline";
import {
  agendaStatusLabel,
  agendaStatusTone,
  type Agenda,
  type CheckItem,
  type DispositionId,
  type Evidence,
} from "./pas-report-thread-1707-data";

export type EvidenceView = { evidence: Evidence; trigger: HTMLElement | null } | null;

export function PasReportThreadReport({ agendas, activeId, open, onSelect, onClose, openTriggerRef, checks, questionAnswers,
  onToggleCheck, onInstruct, onChooseAnswer, target, onClearTarget, instruction, onChangeInstruction, onSendInstruction, onDispose, undoLabel, onUndo,
  evidenceView, onOpenEvidence, onCloseEvidence, documentId, onOpenDocument, onCloseDocument }: {
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
  onSendInstruction(): void;
  onDispose(disposition: DispositionId): void;
  undoLabel: string | null;
  onUndo(): void;
  evidenceView: EvidenceView;
  onOpenEvidence(evidence: Evidence, trigger: HTMLElement | null): void;
  onCloseEvidence(): void;
  documentId: string | null;
  onOpenDocument(documentId: string): void;
  onCloseDocument(): void;
}) {
  const activeIndex = agendas.findIndex((agenda) => agenda.id === activeId);
  const agenda = agendas[Math.max(0, activeIndex)];
  const pending = agendas.filter((item) => item.status === "review");
  const pendingIndex = pending.findIndex((item) => item.id === agenda.id);
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: 0 });
  }, [agenda.id]);
  useEffect(() => {
    if (!open) return;
    // 안쪽 창(증거 확대, 문서 열람)이 떠 있으면 Escape는 그 창만 닫는다. 두 창이 함께
    // 닫히면 문서를 읽던 자리와 보고 창을 모두 잃는다.
    const closeInner = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (documentId) { event.preventDefault(); event.stopImmediatePropagation(); onCloseDocument(); return; }
      if (evidenceView) { event.preventDefault(); event.stopImmediatePropagation(); onCloseEvidence(); }
    };
    document.addEventListener("keydown", closeInner, true);
    return () => document.removeEventListener("keydown", closeInner, true);
  }, [open, documentId, evidenceView, onCloseDocument, onCloseEvidence]);
  const go = (delta: number) => {
    const next = agendas[Math.min(agendas.length - 1, Math.max(0, activeIndex + delta))];
    if (next && next.id !== agenda.id) onSelect(next.id);
    threadRef.current?.scrollTo({ top: 0 });
  };
  return <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPopup className="v3-surface pas-rt1707-dialog" showCloseButton={false} data-testid="pas-report-thread-dialog"
        initialFocus={() => document.querySelector<HTMLElement>('[data-testid="pas-report-thread-dialog"] .pas-rt1707-rail-item[data-active="true"]')}
        finalFocus={() => openTriggerRef.current}
        onKeyDown={(event) => {
          const element = event.target as HTMLElement | null;
          if (element?.closest("input, textarea, [contenteditable='true'], [role='textbox']")) return;
          if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
          if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
        }}>
        <header className="pas-rt1707-report-head">
          <div className="pas-rt1707-report-heading">
            <span className="pas-rt1707-report-number">#{agenda.number}</span>
            <DialogTitle className="pas-rt1707-report-title">{agenda.title}</DialogTitle>
            <StatusChip label={agendaStatusLabel(agenda)} tone={agendaStatusTone(agenda)} />
            {agenda.keptAsReference ? <Badge variant="info" size="sm">참고</Badge> : null}
          </div>
          <div className="pas-rt1707-report-tools">
            {agenda.status === "review" ? <span className="pas-rt1707-report-count" aria-label={`${pending.length}건 가운데 ${pendingIndex + 1}번째`}>{pendingIndex + 1} / {pending.length}</span> : null}
            <DashboardIconCap size="small" appearance="bare" label="이전 안건" disabled={activeIndex <= 0} onClick={() => go(-1)}><ChevronLeft className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
            <DashboardIconCap size="small" appearance="bare" label="다음 안건" disabled={activeIndex >= agendas.length - 1} onClick={() => go(1)}><ChevronRight className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
            <DashboardIconCap size="small" appearance="bare" label="보고 창 닫기" onClick={onClose}><X className="size-5" strokeWidth={1.4} aria-hidden="true" /></DashboardIconCap>
          </div>
        </header>
        <div className="pas-rt1707-report-main">
          <PasThreadRail agendas={agendas} activeId={agenda.id} onSelect={onSelect} />
          <div className="pas-rt1707-thread">
            <div ref={threadRef} className="pas-rt1707-thread-scroll">
              <PasThreadTimeline agenda={agenda} checks={checks} questionAnswer={questionAnswers[agenda.id] ?? null}
                onToggleCheck={onToggleCheck} onInstruct={onInstruct} onOpenEvidence={onOpenEvidence} onOpenDocument={onOpenDocument} />
            </div>
            <PasThreadDecideBox agenda={agenda} target={target} onClearTarget={onClearTarget} text={instruction}
              onChangeText={onChangeInstruction} onSend={onSendInstruction} onDispose={onDispose}
              questionAnswer={questionAnswers[agenda.id] ?? null} onChooseQuestion={(label) => onChooseAnswer(agenda, label)}
              undoLabel={undoLabel} onUndo={onUndo} />
          </div>
        </div>
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
