// 확인할 것 장부. 행을 누르면 그 자리에서 펼쳐지고, 근거 그림은 정본 Dialog 로 크게 본다.
// 지켜보는 중 선반은 장부 아래 한 줄 막대로 접혀 있다.
import { useRef, useState } from "react";
import { ChevronDown, Clock3, X } from "lucide-react";
import {
  Button,
  DashboardIconCap,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@seosoyoung/soul-ui";

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
  onOpenChange,
}: {
  evidence: TriageEvidence | null;
  onOpenChange(open: boolean): void;
}) {
  return (
    <Dialog open={evidence !== null} onOpenChange={onOpenChange}>
      <DialogPopup
        className="v3-ht-dialog"
        showCloseButton={false}
        data-testid="v3-ht-dialog"
        style={{ maxWidth: "min(720px, calc(100vw - 2rem))" }}
      >
        <DialogHeader className="v3-ht-dialog-head">
          <div>
            <DialogTitle>{evidence?.label ?? "근거 크게 보기"}</DialogTitle>
            <DialogDescription>{evidence?.note ?? ""}</DialogDescription>
          </div>
          <DashboardIconCap
            label="근거 닫기"
            onClick={() => onOpenChange(false)}
            data-testid="v3-ht-dialog-close"
          >
            <X className="size-5" strokeWidth={1.4} absoluteStrokeWidth />
          </DashboardIconCap>
        </DialogHeader>
        <DialogPanel className="v3-ht-dialog-body">
          <div className="v3-ht-evidence-canvas">
            {evidence ? <EvidenceDiagram diagram={evidence.diagram} /> : null}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function EvidenceCards({
  card,
  onPreview,
}: {
  card: TriageCard;
  onPreview(evidence: TriageEvidence, opener: HTMLElement): void;
}) {
  if (card.evidence.length === 0) return null;
  return (
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
          <div className="v3-ht-direct-row">
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenSession}
              data-testid={`v3-ht-direct-${card.number}`}
            >
              세션에 직접 답하기
            </Button>
          </div>
        </section>
      ) : (
        <>
          <div className="v3-ht-request">
            <p className="v3-ht-detail-label">요청</p>
            <p>{card.request}</p>
          </div>
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
        </>
      )}
      <EvidenceCards card={card} onPreview={onPreview} />
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
  folderSelected,
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
  folderSelected: boolean;
  undo: { message: string } | null;
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
    const opener = openerRef.current;
    openerRef.current = null;
    requestAnimationFrame(() => opener?.focus());
  };

  return (
    <section className="v3-ht-triage" aria-label="확인할 것">
      <div className="v3-ht-section-head">
        <h2>확인할 것</h2>
        <span className="v3-ht-section-count">{pending.length}건</span>
        <span className="v3-ht-spacer" />
        <Button variant="outline" size="sm" onClick={onNext} data-testid="v3-ht-next">
          다음 안건
        </Button>
      </div>
      {undo ? (
        <div className="v3-ht-undo" role="status" data-testid="v3-ht-undo">
          <span>{undo.message}</span>
          <button type="button" className="v3-ht-undo-button" onClick={onUndo}>되돌리기</button>
        </div>
      ) : null}
      {pending.length === 0 ? (
        <div className="v3-ht-empty" data-testid="v3-ht-empty">
          <p>{folderSelected ? "이 폴더에 확인할 것이 없습니다." : "확인할 안건을 모두 처리했습니다."}</p>
          <p>{folderSelected ? "다른 폴더를 고르거나 지켜보는 중 선반을 펼쳐 보세요." : "지켜보는 중 선반에서 남은 카드를 마저 처리할 수 있습니다."}</p>
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
      <EvidenceDialog
        evidence={preview}
        onOpenChange={open => {
          if (!open) {
            closePreview();
            restoreFocus();
          }
        }}
      />
    </section>
  );
}
