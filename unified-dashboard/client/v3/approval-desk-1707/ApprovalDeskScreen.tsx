import { useEffect, useRef, useState } from "react";
import { Button, DashboardIconCap } from "@seosoyoung/soul-ui";
import { ChevronLeft, ChevronRight, Undo2 } from "lucide-react";
import { ApprovalDeskDocument, type QuestionAction } from "./ApprovalDeskDocument";
import { ApprovalDeskStampBar, type DispositionKind } from "./ApprovalDeskStampBar";
import { EvidenceDialog } from "./EvidenceDialog";
import { GlassPanel } from "./GlassPanel";
import type { EvidenceSpec, PendingDoc } from "./approval-desk-data";

export interface DeskAction {
  doc: PendingDoc;
  kind: DispositionKind;
  detail?: string;
}

const ACTION_LABEL: Record<DispositionKind, string> = {
  supplement: "보완 지시로 넘겼습니다",
  snooze: "다시 보기로 미뤘습니다",
  reference: "참고 서재로 갈무리했습니다",
  approve: "승인 완료로 넘겼습니다",
};

export function ApprovalDeskScreen({ docs, current, questionAction, onSelect, onDispose, onUndo, lastAction, onOpenHome, onOpenOverlay, onQuestionAction, onQuestionActionSubmit, onQuestionActionCancel, onOpenDocument, onReset }: {
  docs: PendingDoc[];
  current: PendingDoc | null;
  questionAction: QuestionAction | null;
  onSelect(id: string): void;
  onDispose(doc: PendingDoc, kind: DispositionKind, detail?: string): void;
  onUndo(): void;
  lastAction: DeskAction | null;
  onOpenHome(): void;
  onOpenOverlay(doc: PendingDoc, trigger: HTMLElement): void;
  onQuestionAction(kind: QuestionAction): void;
  onQuestionActionSubmit(doc: PendingDoc, action: QuestionAction, note: string): void;
  onQuestionActionCancel(): void;
  onOpenDocument(documentId: string): void;
  onReset(): void;
}) {
  const [evidence, setEvidence] = useState<EvidenceSpec | null>(null);
  const evidenceTrigger = useRef<HTMLButtonElement | null>(null);
  const overlayTrigger = useRef<HTMLButtonElement>(null);
  const index = current ? docs.findIndex(doc => doc.id === current.id) : -1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (document.querySelector("dialog[open]")) return;
      if (index < 0) return;
      const next = event.key === "ArrowLeft" ? index - 1 : index + 1;
      if (next < 0 || next >= docs.length) return;
      event.preventDefault();
      onSelect(docs[next]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docs, index, onSelect]);

  const closeEvidence = () => {
    setEvidence(null);
    requestAnimationFrame(() => evidenceTrigger.current?.focus());
  };
  const showOverlay = () => {
    if (!current || !overlayTrigger.current) return;
    onOpenOverlay(current, overlayTrigger.current);
  };

  return <div className="ad1707-screen ad1707-desk" data-screen="desk">
    <div className="ad1707-desk-scroll">
      <div className={`ad1707-desk-inner${docs.length === 0 ? " is-empty" : ""}`}>
        {docs.length > 0 ? <div className="ad1707-filmstrip-row">
          <DashboardIconCap label="앞 서류" disabled={index <= 0} onClick={() => index > 0 && onSelect(docs[index - 1]!.id)}>
            <ChevronLeft className="size-5" strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" />
          </DashboardIconCap>
          <ol className="ad1707-filmstrip" aria-label="결재 안건">
            {docs.map(doc => <li key={doc.id}>
              <button type="button" className={`ad1707-filmstrip-item${doc.id === current?.id ? " is-active" : ""}`}
                aria-current={doc.id === current?.id ? "true" : undefined}
                onClick={() => onSelect(doc.id)}>
                <span className="ad1707-filmstrip-number">#{doc.number}</span>
                <span className="ad1707-filmstrip-kind">{doc.kindLabel}{doc.subLabel ? ` ${doc.subLabel}` : ""}</span>
                <span className="ad1707-filmstrip-title">{doc.title}</span>
              </button>
            </li>)}
          </ol>
          <DashboardIconCap label="다음 서류" disabled={index < 0 || index >= docs.length - 1}
            onClick={() => index >= 0 && index < docs.length - 1 && onSelect(docs[index + 1]!.id)}>
            <ChevronRight className="size-5" strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" />
          </DashboardIconCap>
          <Button ref={overlayTrigger} variant="glass" size="sm" className="ad1707-overlay-trigger"
            disabled={!current} onClick={showOverlay}>전체 카드와 세션 열기</Button>
        </div> : null}

        {current ? <ApprovalDeskDocument doc={current} questionAction={questionAction}
          onOpenEvidence={(next, trigger) => { evidenceTrigger.current = trigger; setEvidence(next); }}
          onSupplement={(doc, note) => onDispose(doc, "supplement", note)}
          onAnswer={(doc, option) => onDispose(doc, "approve", option)}
          onQuestionActionSubmit={onQuestionActionSubmit}
          onQuestionActionCancel={onQuestionActionCancel}
          onOpenDocument={onOpenDocument} /> : <GlassPanel as="section" className="ad1707-desk-empty border border-glass-border" aria-label="결재 데스크 빈 상태">
          <h2>오늘 넘길 서류를 모두 넘겼습니다</h2>
          <p>확인할 것과 참고 서재는 홈 플래너에서 이어 볼 수 있습니다.</p>
          <div className="ad1707-desk-empty-actions">
            <Button variant="glass" onClick={onOpenHome}>홈 플래너 보기</Button>
            <Button variant="outline" onClick={onReset}>예시 5건 다시 불러오기</Button>
          </div>
        </GlassPanel>}
      </div>
    </div>

    {lastAction ? <div className="ad1707-undo-seat">
      <div className="ad1707-undo" role="status">
        <span>{ACTION_LABEL[lastAction.kind]}{lastAction.detail ? `: ${lastAction.detail}` : ""}</span>
        <button type="button" className="ad1707-undo-button" onClick={onUndo}>
          <Undo2 className="size-4" aria-hidden="true" />되돌리기
        </button>
      </div>
    </div> : null}

    {current ? <div className="ad1707-stamp-seat">
      <ApprovalDeskStampBar doc={current} onDispose={onDispose} onQuestionAction={onQuestionAction} />
    </div> : null}

    <EvidenceDialog evidence={evidence} onClose={closeEvidence} />
  </div>;
}
