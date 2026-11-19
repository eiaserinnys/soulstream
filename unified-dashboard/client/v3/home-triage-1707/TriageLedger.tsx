// 확인할 것 장부. 행을 누르면 그 자리에서 펼쳐지고, 근거 그림은 대화상자로 크게 본다.
// 지켜보는 중 선반은 장부 아래 한 줄 막대로 접혀 있다.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock3, X } from "lucide-react";
import { Button, DashboardIconCap } from "@seosoyoung/soul-ui";

import { StatusChip } from "../StatusChip";
import { EvidenceDiagram } from "./EvidenceDiagram";
import type { ItemState, TriageCard, TriageEvidence, TriageKind, TriageQuestionChoice } from "./triage-data";

const ITEM_STATE_LABEL: Record<ItemState, string> = {
  done: "확인됨",
  changed: "바뀜",
  todo: "남음",
  caveat: "미확인",
};

function primaryLabel(kind: TriageKind): string {
  if (kind === "질문") return "답변하기";
  if (kind === "검수 대기") return "검수 승인";
  return "확인 완료";
}

function EvidenceDialog({
  evidence,
  onDismiss,
  onClosed,
}: {
  evidence: TriageEvidence | null;
  onDismiss(): void;
  onClosed(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (evidence && !dialog.open) dialog.showModal();
    if (!evidence && dialog.open) dialog.close();
  }, [evidence]);

  return (
    <dialog
      ref={ref}
      className="v3-ht-dialog glass-strong glass-chrome lg-rim"
      aria-label={evidence ? `${evidence.label} 크게 보기` : "근거 크게 보기"}
      onClose={() => {
        onDismiss();
        onClosed();
      }}
      onCancel={event => {
        event.preventDefault();
        onDismiss();
      }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const dialog = ref.current;
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ));
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (!active || !dialog.contains(active)) {
          event.preventDefault();
          first.focus();
          return;
        }
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      data-testid="v3-ht-dialog"
    >
      {evidence ? (
        <div className="v3-ht-dialog-body">
          <header className="v3-ht-dialog-head">
            <div>
              <h2>{evidence.label}</h2>
              <p>{evidence.note}</p>
            </div>
            <DashboardIconCap label="근거 닫기" onClick={onDismiss} data-testid="v3-ht-dialog-close">
              <X className="size-5" strokeWidth={1.4} absoluteStrokeWidth />
            </DashboardIconCap>
          </header>
          <div className="v3-ht-evidence-canvas">
            <EvidenceDiagram diagram={evidence.diagram} />
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

function LedgerDetail({
  card,
  onShelve,
  onPrimary,
  onAnswer,
  onOpenSession,
  onPreview,
}: {
  card: TriageCard;
  onShelve(): void;
  onPrimary(): void;
  onAnswer(choice: TriageQuestionChoice): void;
  onOpenSession(): void;
  onPreview(evidence: TriageEvidence, opener: HTMLElement): void;
}) {
  return (
    <div className="v3-ht-detail" id={`v3-ht-detail-${card.id}`}>
      <div className="v3-ht-request">
        <p className="v3-ht-detail-label">요청</p>
        <p>{card.request}</p>
      </div>
      <p className="v3-ht-scope">{card.scope}</p>
      {card.question ? (
        <section className="v3-ht-question" aria-label="질문 선택지" data-testid={`v3-ht-question-${card.number}`}>
          <p className="v3-ht-question-intro">{card.question.intro}</p>
          <div className="v3-ht-choices">
            {card.question.choices.map(choice => (
              <button
                key={choice.id}
                type="button"
                className="v3-ht-choice"
                data-recommended={choice.recommended || undefined}
                onClick={() => onAnswer(choice)}
                data-testid={`v3-ht-choice-${card.number}-${choice.id}`}
              >
                <span>{choice.label}</span>
                {choice.recommended ? <span className="v3-ht-choice-hint">(권함)</span> : null}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="v3-ht-choice-direct"
            onClick={onOpenSession}
            data-testid={`v3-ht-direct-${card.number}`}
          >
            세션에 직접 답하기
          </button>
        </section>
      ) : null}
      <ul className="v3-ht-items" aria-label="확인 항목">
        {card.items.map(item => (
          <li key={item.title} className="v3-ht-item" data-state={item.state}>
            <span className="v3-ht-item-state">{ITEM_STATE_LABEL[item.state]}</span>
            <div>
              <strong>{item.title}</strong>
              <p>{item.result}</p>
            </div>
          </li>
        ))}
      </ul>
      {card.evidence.length > 0 ? (
        <div className="v3-ht-evidence" aria-label="근거 그림">
          {card.evidence.map(evidence => (
            <button
              key={evidence.id}
              type="button"
              className="v3-ht-evidence-thumb"
              onClick={event => onPreview(evidence, event.currentTarget)}
              aria-label={`${evidence.label} 크게 보기`}
              data-testid={`v3-ht-evidence-${evidence.id}`}
            >
              <span className="v3-ht-thumb"><EvidenceDiagram diagram={evidence.diagram} /></span>
              <span className="v3-ht-thumb-label">{evidence.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="v3-ht-actions">
        {card.question ? null : (
          <Button size="sm" onClick={onPrimary} data-testid={`v3-ht-primary-${card.number}`}>
            {primaryLabel(card.kind)}
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onShelve} data-testid={`v3-ht-shelve-${card.number}`}>
          지켜보기 선반으로
        </Button>
        {card.question ? null : (
          <Button variant="ghost" size="sm" onClick={onOpenSession}>
            세션 로그 보기
          </Button>
        )}
      </div>
    </div>
  );
}

export function TriageLedger({
  pending,
  selectedId,
  onSelect,
  onNext,
  onShelve,
  onPrimary,
  onAnswer,
  onOpenSession,
  watched,
  shelfOpen,
  onToggleShelf,
  onReopen,
  onComplete,
  onCompleteAll,
  undo,
  onUndo,
}: {
  pending: TriageCard[];
  selectedId: string | null;
  onSelect(id: string): void;
  onNext(): void;
  onShelve(card: TriageCard): void;
  onPrimary(card: TriageCard): void;
  onAnswer(card: TriageCard, choice: TriageQuestionChoice): void;
  onOpenSession(): void;
  watched: TriageCard[];
  shelfOpen: boolean;
  onToggleShelf(): void;
  onReopen(card: TriageCard): void;
  onComplete(card: TriageCard): void;
  onCompleteAll(): void;
  undo: TriageCard | null;
  onUndo(): void;
}) {
  const [preview, setPreview] = useState<TriageEvidence | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const openPreview = (evidence: TriageEvidence, opener: HTMLElement) => {
    openerRef.current = opener;
    setPreview(evidence);
  };
  const closePreview = () => setPreview(null);
  const restoreFocus = () => {
    openerRef.current?.focus();
    openerRef.current = null;
  };

  return (
    <section className="v3-ht-triage" aria-label="확인할 것">
      <div className="v3-ht-section-head">
        <h2>확인할 것</h2>
        <span className="v3-ht-section-count">{pending.length}건</span>
        <span className="v3-ht-spacer" />
        <Button variant="ghost" size="sm" onClick={onNext} data-testid="v3-ht-next">
          다음 안건
        </Button>
      </div>
      {undo ? (
        <div className="v3-ht-undo" role="status" data-testid="v3-ht-undo">
          <span>#{undo.number} {undo.title} 을 지켜보는 중 선반으로 옮겼습니다.</span>
          <button type="button" className="v3-ht-undo-button" onClick={onUndo}>되돌리기</button>
        </div>
      ) : null}
      {pending.length === 0 ? (
        <div className="v3-ht-empty">
          <p>이 폴더에 확인할 것이 없습니다.</p>
          <p>다른 폴더를 고르거나 지켜보는 중 선반을 펼쳐 보세요.</p>
        </div>
      ) : (
        <ol className="v3-ht-ledger" aria-label="확인할 것 장부" data-testid="v3-ht-ledger">
          {pending.map(card => {
            const open = card.id === selectedId;
            return (
              <li key={card.id} className="v3-ht-row" data-open={open}>
                <button
                  type="button"
                  className="v3-ht-row-summary"
                  aria-expanded={open}
                  aria-controls={`v3-ht-detail-${card.id}`}
                  onClick={() => onSelect(card.id)}
                  data-testid={`v3-ht-row-${card.number}`}
                >
                  <span className="v3-ht-row-number">#{card.number}</span>
                  <StatusChip label={card.kind} tone={card.tone} />
                  <span className="v3-ht-row-title">{card.title}</span>
                  <span className="v3-ht-row-folder">{card.folderLabel}</span>
                  <span className="v3-ht-row-waited">{card.waited}</span>
                  <ChevronDown className="v3-ht-row-caret" aria-hidden="true" size={16} />
                </button>
                {open ? (
                  <LedgerDetail
                    card={card}
                    onShelve={() => onShelve(card)}
                    onPrimary={() => onPrimary(card)}
                    onAnswer={choice => onAnswer(card, choice)}
                    onOpenSession={onOpenSession}
                    onPreview={openPreview}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <section className="v3-ht-shelf" data-open={shelfOpen}>
        <div className="v3-ht-shelf-bar">
          <button
            type="button"
            className="v3-ht-shelf-toggle"
            aria-expanded={shelfOpen}
            onClick={onToggleShelf}
            data-testid="v3-ht-shelf-toggle"
          >
            <Clock3 className="v3-ht-shelf-mark" aria-hidden="true" size={16} />
            <span>지켜보는 중</span>
            <span className="v3-ht-shelf-count" data-testid="v3-ht-shelf-count">{watched.length}건</span>
            <ChevronDown className="v3-ht-shelf-caret" aria-hidden="true" size={16} />
          </button>
          {shelfOpen && watched.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={onCompleteAll} data-testid="v3-ht-shelf-complete-all">
              지켜보는 카드 일괄 완료
            </Button>
          ) : null}
        </div>
        {shelfOpen ? (
          watched.length === 0 ? (
            <p className="v3-ht-shelf-empty">지켜보는 카드가 없습니다.</p>
          ) : (
            <ul className="v3-ht-shelf-list">
              {watched.map(card => (
                <li key={card.id} className="v3-ht-shelf-row">
                  <span className="v3-ht-row-number">#{card.number}</span>
                  <span className="v3-ht-shelf-title">{card.title}</span>
                  <span className="v3-ht-row-folder">{card.folderLabel}</span>
                  <span className="v3-ht-shelf-actions">
                    <Button variant="ghost" size="sm" onClick={() => onReopen(card)}>다시 열기</Button>
                    <Button variant="outline" size="sm" onClick={() => onComplete(card)}>완료</Button>
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
      <EvidenceDialog evidence={preview} onDismiss={closePreview} onClosed={restoreFocus} />
    </section>
  );
}
