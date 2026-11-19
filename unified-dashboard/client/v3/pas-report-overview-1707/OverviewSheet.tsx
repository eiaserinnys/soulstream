import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import {
  Button,
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  ProfileAvatar,
} from "@seosoyoung/soul-ui";

import { CardCheckItems } from "../CardCheckItems";
import { CardQuestionBody, type CardQuestionView } from "../CardQuestionBlock";
import { DocumentReaderDialog } from "../DocumentReaderDialog";
import { StatusChip } from "../StatusChip";
import { OverviewEvidenceArt } from "./OverviewEvidenceArt";
import {
  AGENTS,
  agentPortrait,
  isPendingCard,
  overviewStatusLabel,
  type OverviewAction,
  type OverviewScenario,
} from "./pas-report-overview-1707-data";
import { overviewTargetLabel, type OverviewTarget, type OverviewUndo } from "./use-pas-report-overview-1707";
import "./v3-pas-report-overview-1707.css";

function questionViewOf(card: OverviewScenario): CardQuestionView | null {
  if (!card.question) return null;
  return {
    id: `question-${card.number}`,
    title: null,
    background: card.question.background,
    kind: card.question.kind,
    options: card.question.options.map(option => ({
      label: option.label,
      description: option.description,
      recommended: Boolean(option.recommended),
    })),
    attachments: [],
    thread: [],
    open: isPendingCard(card),
    selectedOption: null,
    answer: null,
    revisedAt: null,
    awaitingAgent: false,
  };
}

const EDITABLE_SELECTOR = "textarea, input, select, [contenteditable='true']";

export function OverviewSheet({
  card, stripCards, target, composer, undo, questionReset,
  onSetActive, onGo, onClose, onChoose, onApplyAction, onSendInstruction, onUndo, onPickTarget, onClearTarget,
  onComposerChange, onConfirmItem,
}: {
  card: OverviewScenario;
  stripCards: readonly OverviewScenario[];
  target: OverviewTarget | null;
  composer: string;
  undo: OverviewUndo | null;
  questionReset: number;
  onSetActive(cardId: string): void;
  onGo(step: number): void;
  onClose(): void;
  onChoose(label: string): Promise<boolean>;
  onApplyAction(action: OverviewAction): boolean;
  onSendInstruction(): boolean;
  onUndo(): void;
  onPickTarget(target: OverviewTarget): void;
  onClearTarget(): void;
  onComposerChange(value: string): void;
  onConfirmItem(itemId: number, confirmed: boolean): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const evidencePanelRef = useRef<HTMLDivElement>(null);
  const columnRefs = useRef<Array<HTMLDivElement | null>>([null, null, null]);
  const evidenceTrigger = useRef<HTMLElement | null>(null);
  const readerTrigger = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [readerId, setReaderId] = useState<string | null>(null);
  const agent = AGENTS[card.agent];
  const userPortrait = agentPortrait("seosoyoung");
  const pending = isPendingCard(card);
  const questionView = questionViewOf(card);

  const focusInput = useCallback(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, []);

  const pickTarget = (next: OverviewTarget) => {
    onPickTarget(next);
    focusInput();
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // 처분 단추가 사라진 뒤에는 초점이 문서 몸통으로 떨어진다. 그래도 Esc가 먹도록
  // 창 수준에서 한 번 받는다. 증거와 문서 대화상자가 열려 있으면 그쪽에 맡긴다.
  useEffect(() => {
    const onDocumentKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || evidenceOpen || readerId) return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onDocumentKey, true);
    return () => document.removeEventListener("keydown", onDocumentKey, true);
  }, [evidenceOpen, readerId, onClose]);

  useEffect(() => {
    setEvidenceOpen(false);
    setReaderId(null);
    for (const column of columnRefs.current) column?.scrollTo({ top: 0 });
  }, [card.id]);

  const openEvidence = () => {
    evidenceTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEvidenceOpen(true);
  };

  const closeEvidence = () => {
    setEvidenceOpen(false);
    window.requestAnimationFrame(() => evidenceTrigger.current?.focus({ preventScroll: true }));
  };

  const openReader = (documentId: string) => {
    readerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReaderId(documentId);
  };

  const closeReader = () => {
    setReaderId(null);
    window.requestAnimationFrame(() => readerTrigger.current?.focus({ preventScroll: true }));
  };

  const send = () => {
    if (onSendInstruction()) focusInput();
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const onSheetKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (evidenceOpen || readerId) return;
      event.stopPropagation();
      onClose();
      return;
    }
    const editing = event.target instanceof HTMLElement && Boolean(event.target.closest(EDITABLE_SELECTOR));
    if (!editing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      onGo(event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.key !== "Tab") return;
    const root = panelRef.current;
    if (!root) return;
    const focusables = Array.from(root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
    )).filter(element => element.offsetParent !== null || element === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const jumpTo = (index: number) => {
    columnRefs.current[index]?.scrollIntoView({ block: "start" });
  };

  return <div className="pas-ro1707-sheet" data-testid="overview-sheet"
    onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }} onKeyDown={onSheetKeyDown}>
    <div className="pas-ro1707-scrim" aria-hidden="true" />
    <div ref={panelRef} className="pas-ro1707-sheet-panel" role="dialog" aria-modal="true"
      aria-labelledby="pas-ro1707-sheet-title" tabIndex={-1}>
      <header className="pas-ro1707-sheet-head">
        <div className="pas-ro1707-strip">
          <span className="pas-ro1707-icon-seat">
            <button type="button" className="pas-ro1707-arrow" aria-label="앞 안건" disabled={stripCards.length < 2} onClick={() => onGo(-1)}>
              <ArrowLeft className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
            </button>
          </span>
          <div className="pas-ro1707-chips" role="group" aria-label="미결 안건">
            {stripCards.map(item => <button type="button" className="pas-ro1707-chip" key={item.id}
              data-active={item.id === card.id || undefined} data-status={item.status}
              aria-pressed={item.id === card.id}
              title={`#${item.number} ${item.title}`} onClick={() => onSetActive(item.id)}>
              <ProfileAvatar role="assistant" hasPortrait portraitUrl={agentPortrait(item.agent)} fallbackEmoji="🤖" />
              <span className="pas-ro1707-chip-number">#{item.number}</span>
              <span className="pas-ro1707-chip-title">{item.title}</span>
            </button>)}
          </div>
          <span className="pas-ro1707-icon-seat">
            <button type="button" className="pas-ro1707-arrow" aria-label="다음 안건" disabled={stripCards.length < 2} onClick={() => onGo(1)}>
              <ArrowRight className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="pas-ro1707-sheet-title-row">
          <h1 id="pas-ro1707-sheet-title" className="pas-ro1707-sheet-title" data-testid="overview-title">#{card.number} {card.title}</h1>
          <StatusChip label={overviewStatusLabel(card)} tone={card.status === "blocked" ? "question" : card.status} />
          <span className="pas-ro1707-sheet-kind">{card.kind}</span>
          <span className="pas-ro1707-icon-seat">
            <button type="button" className="pas-ro1707-arrow" aria-label="보고 창 닫기" onClick={onClose}>
              <X className="size-4" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="pas-ro1707-jump" role="group" aria-label="구역 바로가기">
          <button type="button" onClick={() => jumpTo(0)}>항목과 증거</button>
          <button type="button" onClick={() => jumpTo(1)}>커멘트 {card.comments.length}</button>
          <button type="button" onClick={() => jumpTo(2)}>세션 대화 {card.turns.length}</button>
        </div>
      </header>

      <div className="pas-ro1707-cols">
        <section className="pas-ro1707-col" data-column="1" data-testid="overview-col-1" aria-label="요청과 확인 항목">
          <header className="pas-ro1707-col-head">
            <span className="pas-ro1707-col-kicker">요청과 확인 항목</span>
            <span className="pas-ro1707-col-meta"><ProfileAvatar role="assistant" hasPortrait portraitUrl={agentPortrait(card.agent)} fallbackEmoji="🤖" />{agent.name}</span>
          </header>
          <div className="pas-ro1707-col-scroll" ref={element => { columnRefs.current[0] = element; }}>
            <h2 className="pas-ro1707-section-title">원 요청</h2>
            <p className="pas-ro1707-request" data-testid="overview-request">{card.request}</p>
            {questionView ? <div className="pas-ro1707-question">
              <CardQuestionBody key={`question-${card.id}-${questionReset}`} view={questionView} portraitUrl={agentPortrait(card.agent)}
                userPortraitUrl={userPortrait} onChoose={onChoose} />
              {pending ? <div className="pas-ro1707-question-actions">
                <Button size="sm" variant="outline" onClick={() => pickTarget({ kind: "answer" })}>다르게 답하기</Button>
                <Button size="sm" variant="ghost" onClick={() => pickTarget({ kind: "askBack" })}>되묻기</Button>
              </div> : null}
            </div> : null}
            <h2 className="pas-ro1707-section-title">확인 항목 {card.items.length}</h2>
            <CardCheckItems items={card.items} readOnly={!pending}
              onConfirmChange={(itemId, confirmed) => onConfirmItem(itemId, confirmed)}
              onTargetItem={itemId => pickTarget({ kind: "item", itemId })} />
            <h2 className="pas-ro1707-section-title">대표 시각 증거</h2>
            <button type="button" className="pas-ro1707-evidence" data-testid="overview-evidence" onClick={openEvidence}
              aria-label={`${card.evidence.label} 도표 크게 보기`}>
              <OverviewEvidenceArt kind={card.evidence.kind} />
              <span className="pas-ro1707-evidence-caption">{card.evidence.label}<small>{card.evidence.caption}</small></span>
            </button>
            {card.documentId ? <Button variant="outline" className="pas-ro1707-reader-open" onClick={() => openReader(card.documentId!)}>
              설계 문서 전문 읽기
            </Button> : null}
          </div>
        </section>

        <section className="pas-ro1707-col" data-column="2" data-testid="overview-col-2" aria-label="전체 커멘트">
          <header className="pas-ro1707-col-head">
            <span className="pas-ro1707-col-kicker">전체 커멘트</span>
            <span className="pas-ro1707-col-meta">{card.comments.length}건</span>
          </header>
          <div className="pas-ro1707-col-scroll" ref={element => { columnRefs.current[1] = element; }} data-testid="overview-comments">
            <ol className="pas-ro1707-comments">
              {card.comments.map(comment => <li key={comment.id} data-author={comment.author} data-testid="overview-comment">
                <ProfileAvatar role={comment.author === "user" ? "user" : "assistant"} hasPortrait
                  portraitUrl={comment.author === "user" ? userPortrait : agentPortrait(card.agent)}
                  fallbackEmoji={comment.author === "user" ? "👤" : "🤖"} />
                <div className="pas-ro1707-comment">
                  <div className="pas-ro1707-comment-head">
                    <strong>{comment.authorName}</strong>
                    <time>{comment.at}</time>
                    {comment.itemId ? <span className="pas-ro1707-badge">대상: {comment.itemId}번 항목</span> : null}
                    {comment.question ? <span className="pas-ro1707-badge" data-kind="question">질문 글타래</span> : null}
                  </div>
                  <p className="pas-ro1707-comment-body">{comment.body}</p>
                </div>
              </li>)}
            </ol>
          </div>
        </section>

        <section className="pas-ro1707-col" data-column="3" data-testid="overview-col-3" aria-label="담당 세션 대화">
          <header className="pas-ro1707-col-head">
            <ProfileAvatar role="assistant" hasPortrait portraitUrl={agentPortrait(card.agent)} fallbackEmoji="🤖" />
            <span className="pas-ro1707-session-id">
              <strong>{agent.name}</strong>
              <small>{card.sessionTitle}</small>
            </span>
            <Button size="sm" variant="outline" onClick={() => pickTarget({ kind: "session" })}>담당 세션에 지시</Button>
          </header>
          <div className="pas-ro1707-col-scroll" ref={element => { columnRefs.current[2] = element; }} data-testid="overview-session">
            <ol className="pas-ro1707-turns">
              {card.turns.map(turn => <li key={turn.id} data-role={turn.role} data-testid="overview-turn">
                <div className="pas-ro1707-turn-head"><strong>{turn.author}</strong><time>{turn.time}</time></div>
                <p className="pas-ro1707-turn-body">{turn.text}</p>
              </li>)}
            </ol>
            <div className="pas-ro1707-outcome">
              <h2 className="pas-ro1707-section-title">최종 산출</h2>
              <p>{card.outcome}</p>
            </div>
          </div>
        </section>
      </div>

      <div className="pas-ro1707-dock" data-testid="overview-dock">
        <div className="pas-ro1707-dock-compose">
          <div className="pas-ro1707-target-row">
            <span className="pas-ro1707-target-chip" data-target={target?.kind ?? "all"} data-testid="overview-target">
              {overviewTargetLabel(target)}
              {target ? <button type="button" aria-label="입력 대상 해제" onClick={onClearTarget}>
                <X className="size-3.5" strokeWidth={1.6} absoluteStrokeWidth aria-hidden="true" />
              </button> : null}
            </span>
            <span className="pas-ro1707-target-hint">
              {target ? "지시를 보내면 실행 중으로 옮깁니다." : "전체 커멘트로 남깁니다."}
            </span>
          </div>
          <div className="pas-ro1707-field">
            <textarea ref={inputRef} rows={1} value={composer} aria-label="안건에 남길 지시" placeholder="안건에 남길 지시"
              onChange={event => onComposerChange(event.target.value)} onKeyDown={onComposerKey} />
            <Button onClick={send} disabled={!composer.trim()} data-testid="overview-send">보내기</Button>
          </div>
        </div>
        <div className="pas-ro1707-dock-actions">
          <div className="pas-ro1707-stamps">
            {pending ? <>
              {card.primary ? <Button onClick={() => onApplyAction(card.primary!)} data-testid="overview-primary">{card.primary.label}</Button> : null}
              {card.secondary ? <Button variant="outline" onClick={() => onApplyAction(card.secondary!)}>{card.secondary.label}</Button> : null}
              {!card.primary && !card.secondary
                ? <span className="pas-ro1707-dock-note">선택지를 고르면 이 안건이 완료됩니다.</span>
                : null}
            </> : <span className="pas-ro1707-dock-note">{overviewStatusLabel(card)} 상태입니다. 처분을 마쳤습니다.</span>}
          </div>
          <div className="pas-ro1707-undo-slot" aria-live="polite" data-testid="overview-undo-slot">
            {undo ? <><span className="pas-ro1707-undo-note">방금 처분</span>
              <Button size="xs" variant="ghost" onClick={onUndo} data-testid="overview-undo">되돌리기</Button></> : null}
            {undo?.documentId ? <Button size="xs" variant="ghost" onClick={() => openReader(undo.documentId!)}>문서 열기</Button> : null}
          </div>
        </div>
      </div>
    </div>

    <Dialog open={evidenceOpen} onOpenChange={open => { if (!open) closeEvidence(); }}>
      <DialogPopup initialFocus={evidencePanelRef} className="v3-surface v3-document-reader-dialog max-w-3xl"
        closeProps={{ "aria-label": "도표 닫기" }} data-testid="overview-evidence-dialog">
        <DialogHeader className="pe-14"><DialogTitle>{card.evidence.label}</DialogTitle></DialogHeader>
        <DialogPanel ref={evidencePanelRef} tabIndex={0} role="region" aria-label="대표 시각 증거">
          <div className="pas-ro1707-evidence-large"><OverviewEvidenceArt kind={card.evidence.kind} /></div>
          <p className="pas-ro1707-evidence-caption">{card.evidence.caption}</p>
        </DialogPanel>
      </DialogPopup>
    </Dialog>

    <DocumentReaderDialog documentId={readerId} onClose={closeReader} />
  </div>;
}
