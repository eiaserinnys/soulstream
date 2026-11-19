// 카드 #1707 시안 A. 한 장 결재 브리핑 갑지.
// 다섯 안건을 한 장씩 넘기며 처분한다. 창은 하나의 스크롤 열과 하단 고정 결재 막대로
// 끝나고, 되돌리기 자리는 늘 같은 높이로 비워 둔다.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Badge, Button, DashboardIconCap, Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle, ProfileAvatar,
} from "@seosoyoung/soul-ui";
import { Check, ChevronLeft, ChevronRight, EyeOff, Maximize2, X } from "lucide-react";
import type { CardStatus } from "@seosoyoung/soul-ui/cards/card-types";
import { CardCheckItems } from "../CardCheckItems";
import { StatusChip } from "../StatusChip";
import { AGENT_NAMES, type Agenda, type AgendaStamp, type StampOutcome } from "./data";
import "./v3-pas-report-briefing-1707-dossier.css";

export interface DispositionRecord {
  actionId: string;
  outcome: StampOutcome | "answered";
  label: string;
  message: string;
  taskStatus: CardStatus;
}

export interface ReportNotice {
  agendaKey: string;
  text: string;
}

type Props = {
  agendas: readonly Agenda[];
  index: number;
  dispositions: Readonly<Record<string, DispositionRecord>>;
  notice: ReportNotice | null;
  undoAvailable: boolean;
  checks: Readonly<Record<string, boolean>>;
  onNavigate(index: number): void;
  onChoose(agenda: Agenda, label: string): void;
  onStamp(agenda: Agenda, stamp: AgendaStamp): void;
  onInput(agenda: Agenda, text: string, targetItem: number | null): void;
  onCheck(agendaKey: string, itemId: number, confirmed: boolean): void;
  onUndo(): void;
  onClose(): void;
  onOpenDocument(documentId: string): void;
};

function outcomeChip(disposition: DispositionRecord | undefined): { label: string; tone: string } {
  if (!disposition) return { label: "", tone: "" };
  if (disposition.outcome === "reference") return { label: "완료", tone: "done" };
  if (disposition.outcome === "awaiting") return { label: "검증 대기", tone: "review" };
  if (disposition.outcome === "done" || disposition.outcome === "answered") return { label: "완료", tone: "done" };
  return { label: "실행 중", tone: "running" };
}

function portrait(agent: Agenda["assignee"]): string {
  return `/api/nodes/eiaserinnys/agents/${agent}/portrait`;
}

function EvidenceChart({ agenda, large = false }: { agenda: Agenda; large?: boolean }) {
  if (agenda.bars) {
    const maximum = Math.max(...agenda.bars.rows.map(row => row.value), 1);
    return <figure className="pas-rb-figure" data-large={large || undefined}>
      <figcaption className="pas-rb-figure-caption">{agenda.bars.caption}</figcaption>
      <div className="pas-rb-bars" role="img" aria-label={agenda.bars.caption}>
        {agenda.bars.rows.map(row => <div className="pas-rb-bar-row" key={row.label}>
          <span className="pas-rb-bar-label">{row.label}</span>
          <span className="pas-rb-bar-track"><span className="pas-rb-bar-fill" style={{ width: `${Math.round(row.value / maximum * 100)}%` }} /></span>
          <span className="pas-rb-bar-value">{row.value}건</span>
        </div>)}
      </div>
      <p className="pas-rb-figure-note">{agenda.bars.note}</p>
    </figure>;
  }
  if (agenda.compare) {
    return <figure className="pas-rb-figure" data-large={large || undefined}>
      <figcaption className="pas-rb-figure-caption">{agenda.compare.title}</figcaption>
      <div className="pas-rb-compare" role="img" aria-label={agenda.compare.title}>
        <span className="pas-rb-compare-label" />
        <span className="pas-rb-compare-head">{agenda.compare.columns[0]}</span>
        <span className="pas-rb-compare-head">{agenda.compare.columns[1]}</span>
        {agenda.compare.rows.map(row => <span className="pas-rb-compare-row" key={row.label}>
          <span className="pas-rb-compare-label">{row.label}</span>
          <span className="pas-rb-compare-before">{row.before}</span>
          <span className="pas-rb-compare-after">{row.after}</span>
        </span>)}
      </div>
      <p className="pas-rb-figure-note">{agenda.compare.note}</p>
    </figure>;
  }
  if (agenda.timeline) {
    return <figure className="pas-rb-figure" data-large={large || undefined}>
      <figcaption className="pas-rb-figure-caption">{agenda.timeline.title}</figcaption>
      <div className="pas-rb-timeline" role="img" aria-label={agenda.timeline.title}>
        <span className="pas-rb-timeline-row pas-rb-timeline-head">
          {agenda.timeline.columns.map(column => <span key={column}>{column}</span>)}
        </span>
        {agenda.timeline.rows.map(row => <span className="pas-rb-timeline-row" key={row[0]}>
          {row.map(cell => <span key={cell}>{cell}</span>)}
        </span>)}
      </div>
      <p className="pas-rb-figure-note">{agenda.timeline.note}</p>
    </figure>;
  }
  return null;
}

function EvidenceSection({ agenda, onOpenDocument, onZoom }: {
  agenda: Agenda;
  onOpenDocument(documentId: string): void;
  onZoom(): void;
}) {
  const hasChart = Boolean(agenda.bars || agenda.compare || agenda.timeline);
  return <section className="pas-rb-section" aria-label="대표 시각 증거">
    <h3 className="pas-rb-section-title">근거 자료</h3>
    {hasChart ? <button type="button" className="pas-rb-evidence-open" aria-label="근거 자료 크게 보기" onClick={onZoom}>
      <EvidenceChart agenda={agenda} />
      <span className="pas-rb-zoom"><Maximize2 className="size-4" strokeWidth={1.5} aria-hidden="true" />크게 보기</span>
    </button> : null}
    {agenda.docId ? <div className="pas-rb-doc-link">
      <Button variant="outline" size="sm" onClick={() => onOpenDocument(agenda.docId!)}>{agenda.docLabel ?? "문서 열기"}</Button>
    </div> : null}
    {agenda.steps ? <ol className="pas-rb-steps">{agenda.steps.map(step => <li key={step.n}>
      <span className="pas-rb-step-number">{step.n}</span>
      <span className="pas-rb-step-copy"><strong>{step.title}</strong><span>{step.body}</span></span>
    </li>)}</ol> : null}
    {agenda.caveat ? <p className="pas-rb-caveat"><EyeOff className="size-4" strokeWidth={1.5} aria-hidden="true" /><span>못 본 범위: {agenda.caveat}</span></p> : null}
  </section>;
}

export function PasReviewReportDialog({
  agendas, index, dispositions, notice, undoAvailable, checks,
  onNavigate, onChoose, onStamp, onInput, onCheck, onUndo, onClose, onOpenDocument,
}: Props) {
  const agenda = agendas[Math.max(0, Math.min(agendas.length - 1, index))]!;
  const disposition = dispositions[agenda.key];
  const choiceOptions = agenda.question?.kind === "choice" ? agenda.question.options : null;
  const selectedChoice = disposition?.outcome === "answered" ? disposition.label : null;
  const customAnswer = selectedChoice && !choiceOptions?.some(option => option.label === selectedChoice)
    ? selectedChoice
    : null;
  const [text, setText] = useState("");
  const [targetItem, setTargetItem] = useState<number | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const currentChecks = useMemo(() => {
    const result: Record<number, boolean> = {};
    const prefix = `${agenda.key}:`;
    for (const [key, value] of Object.entries(checks)) {
      if (key.startsWith(prefix)) result[Number(key.slice(prefix.length))] = value;
    }
    return result;
  }, [agenda.key, checks]);
  const checkItems = useMemo(() => agenda.checks?.map(item => (
    currentChecks[item.id] ? { ...item, display: "confirmed" as const } : item
  )), [agenda.checks, currentChecks]);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const initialFocusChoice = useRef(agenda.question?.kind === "choice" && !disposition);

  useEffect(() => {
    setText("");
    setTargetItem(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [agenda.key]);

  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine)").matches;
    if (fine && initialFocusChoice.current) {
      const choice = dialogRef.current?.querySelector<HTMLButtonElement>('[data-testid="pas-rb-choice"]');
      if (choice) { choice.focus(); return; }
    }
    if (fine && inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
    else dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        const nested = document.querySelector('[data-testid="internal-document-dialog"], [data-testid="pas-rb-evidence-dialog"]');
        if (nested || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector('[data-testid="internal-document-dialog"], [data-testid="pas-rb-evidence-dialog"]')) return;
      event.preventDefault();
      onNavigate(Math.max(0, Math.min(agendas.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1))));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [agendas.length, index, onClose, onNavigate]);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    // 안쪽 근거 자료 창과 문서 창은 자기 초점 가둠을 쓴다.
    if (document.querySelector('[data-testid="internal-document-dialog"], [data-testid="pas-rb-evidence-dialog"]')) return;
    const root = dialogRef.current;
    if (!root) return;
    const focusable = [...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(element => element.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (!focusable.includes(document.activeElement as HTMLElement)) {
      // 처분 알림 줄처럼 초점만 받는 자리에서 Tab을 누르면 첫 조작부로 보낸다.
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const chip = outcomeChip(disposition);
  const statusLabel = disposition ? chip.label : agenda.statusLabel;
  const statusTone = disposition ? chip.tone : agenda.statusTone;
  const statusLine = targetItem !== null
    ? `대상: ${targetItem}번 항목, 지시를 적고 보내세요.`
    : notice && notice.agendaKey === agenda.key
      ? notice.text
      : disposition
        ? disposition.message
        : agenda.hint;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || disposition) return;
    onInput(agenda, value, targetItem);
    setText("");
    setTargetItem(null);
    // 처분 뒤 누른 단추가 잠기므로 초점은 결과를 알리는 상태 줄로 옮긴다.
    requestAnimationFrame(() => statusRef.current?.focus({ preventScroll: true }));
  };

  return <div className="v3-workspace-scrim pas-rb-scrim" data-testid="pas-rb-scrim" onKeyDown={trapFocus}
    onPointerDown={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      dialogRef.current?.focus({ preventScroll: true });
    }}>
    <section ref={dialogRef} className="v3-surface pas-rb-dialog" role="dialog" aria-modal="true"
      aria-labelledby="pas-rb-dialog-title" tabIndex={-1} data-testid="pas-rb-dialog">
      <header className="pas-rb-dialog-head">
        <div className="pas-rb-dialog-nav">
          <DashboardIconCap appearance="bare" label="이전 안건" disabled={index <= 0} onClick={() => onNavigate(index - 1)}>
            <ChevronLeft className="size-5" strokeWidth={1.4} aria-hidden="true" />
          </DashboardIconCap>
          <span className="pas-rb-count" data-testid="pas-rb-count">{index + 1} / {agendas.length}</span>
          <DashboardIconCap appearance="bare" label="다음 안건" disabled={index >= agendas.length - 1} onClick={() => onNavigate(index + 1)}>
            <ChevronRight className="size-5" strokeWidth={1.4} aria-hidden="true" />
          </DashboardIconCap>
        </div>
        <ol className="pas-rb-pills" aria-label="안건 번호">
          {agendas.map((item, position) => <li key={item.key}>
            <button type="button" className="pas-rb-pill" data-testid="pas-rb-pill" data-number={item.number}
              data-current={position === index ? "true" : undefined}
              data-disposed={dispositions[item.key] ? "true" : undefined}
              aria-current={position === index ? "true" : undefined} onClick={() => onNavigate(position)}>
              {dispositions[item.key] ? <Check className="size-3" strokeWidth={2} aria-hidden="true" /> : null}
              #{item.number}
            </button>
          </li>)}
        </ol>
        <DashboardIconCap appearance="bare" label="보고 창 닫기" onClick={onClose}>
          <X className="size-5" strokeWidth={1.4} aria-hidden="true" />
        </DashboardIconCap>
      </header>

      <div ref={scrollRef} className="pas-rb-scroll">
        <article className="pas-rb-agenda" data-testid="pas-rb-agenda" data-number={agenda.number} data-v3-selectable-content="true">
          <header className="pas-rb-agenda-head">
            <div className="pas-rb-kicker">
              <span className="pas-rb-number">#{agenda.number}</span>
              {agenda.kindLabel === statusLabel ? null : <Badge variant="outline" size="sm">{agenda.kindLabel}</Badge>}
              <StatusChip label={statusLabel} tone={statusTone} />
              {disposition?.outcome === "reference" ? <Badge variant="info" size="sm">참고</Badge> : null}
            </div>
            <h2 id="pas-rb-dialog-title" className="pas-rb-agenda-title">{agenda.title}</h2>
            <div className="pas-rb-assignee">
              <ProfileAvatar role="assistant" hasPortrait fallbackEmoji="🙂" portraitUrl={portrait(agenda.assignee)} />
              <span>담당 {AGENT_NAMES[agenda.assignee]}</span>
            </div>
          </header>

          <section className="pas-rb-section" aria-label="맥락 브리핑">
            <h3 className="pas-rb-section-title">맥락 브리핑</h3>
            <p className="pas-rb-request"><span className="pas-rb-request-label">원 요청</span>{agenda.request}</p>
            {agenda.summary.map((line, position) => <p className="pas-rb-summary" key={position}>{line}</p>)}
            <details key={agenda.key} className="pas-rb-details">
              <summary>원문 커멘트 {agenda.comments.length}건과 담당 세션 발화 {agenda.spoken.length}건</summary>
              <ol className="pas-rb-comment-list">
                {agenda.comments.map(comment => <li key={comment.id}>
                  <span className="pas-rb-comment-meta">{comment.name}, {comment.at}</span>
                  <span className="pas-rb-comment-body">{comment.body}</span>
                </li>)}
              </ol>
              <ul className="pas-rb-spoken-list">
                {agenda.spoken.map((line, position) => <li key={position}>
                  <span className="pas-rb-comment-meta">{AGENT_NAMES[line.agent]} 세션</span>
                  <span className="pas-rb-comment-body">{line.text}</span>
                </li>)}
              </ul>
            </details>
          </section>

          <EvidenceSection agenda={agenda} onOpenDocument={onOpenDocument} onZoom={() => setEvidenceOpen(true)} />

          {agenda.question?.kind === "choice" || agenda.checks ? <section className="pas-rb-section" aria-label="확인과 결정">
            <h3 className="pas-rb-section-title">확인할 것</h3>
            {agenda.question?.kind === "choice"
              ? <p className="pas-rb-summary">{agenda.question.background}</p>
              : null}
            {agenda.checks ? <CardCheckItems key={agenda.key} items={checkItems}
              onConfirmChange={(itemId, confirmed) => onCheck(agenda.key, itemId, confirmed)}
              onTargetItem={itemId => { setTargetItem(itemId); requestAnimationFrame(() => inputRef.current?.focus()); }} /> : null}
          </section> : null}
        </article>
      </div>

      <footer className="pas-rb-foot" data-testid="pas-rb-foot">
        <div ref={statusRef} tabIndex={-1} className="pas-rb-status" role="status" data-testid="pas-rb-status-line">
          <span className="pas-rb-status-text">{statusLine}</span>
          {targetItem !== null ? <button type="button" className="pas-rb-target-clear" onClick={() => setTargetItem(null)}>해제</button> : null}
        </div>
        <form className="pas-rb-composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="pas-rb-input">지시 또는 답변</label>
          <input ref={inputRef} id="pas-rb-input" data-testid="pas-rb-input" className="pas-rb-input"
            value={text} disabled={Boolean(disposition)} placeholder={agenda.kind === "question" ? "다르게 답하기" : "지시를 적어 보내기"}
            onChange={event => setText(event.target.value)} />
          <Button type="submit" size="sm" disabled={Boolean(disposition) || !text.trim()}>보내기</Button>
        </form>
        <div className="pas-rb-stamps" data-testid="pas-rb-stamp-row">
          <div className="pas-rb-stamp-buttons">
            {customAnswer ? <span className="pas-rb-choice-answer" data-testid="pas-rb-answer">답: <strong>{customAnswer}</strong></span> : null}
            {choiceOptions?.map(option => {
              const selected = selectedChoice === option.label;
              return <Button key={option.label} variant="choice" size="sm" className="pas-rb-choice"
                data-testid="pas-rb-choice" data-choice={option.label}
                data-selected={selected ? "true" : undefined}
                aria-pressed={selected || undefined}
                disabled={Boolean(disposition)} onClick={() => {
                  if (disposition) return;
                  onChoose(agenda, option.label);
                  requestAnimationFrame(() => statusRef.current?.focus({ preventScroll: true }));
                }}>
                {option.label}
                {option.recommended ? <Badge variant="info" size="sm">권함</Badge> : null}
              </Button>;
            })}
            {agenda.stamps.map(stamp => <Button key={stamp.id} variant={stamp.primary ? "default" : "outline"} size="sm"
              data-stamp={stamp.id} data-stamp-primary={stamp.primary ? "true" : undefined}
              data-selected={disposition?.actionId === stamp.id ? "true" : undefined}
              aria-pressed={disposition?.actionId === stamp.id || undefined}
              disabled={Boolean(disposition)} onClick={() => {
                onStamp(agenda, stamp);
                requestAnimationFrame(() => statusRef.current?.focus({ preventScroll: true }));
              }}>{stamp.label}</Button>)}
          </div>
          <div className="pas-rb-undo-slot" data-testid="pas-rb-undo-slot">
            {undoAvailable ? <Button variant="ghost" size="sm" data-testid="pas-rb-undo" onClick={onUndo}>되돌리기</Button> : null}
          </div>
        </div>
      </footer>

      <Dialog open={evidenceOpen} onOpenChange={open => { if (!open) setEvidenceOpen(false); }}>
        <DialogPopup className="v3-surface pas-rb-evidence-popup" data-testid="pas-rb-evidence-dialog"
          closeProps={{ "aria-label": "근거 자료 닫기" }}>
          <DialogHeader><DialogTitle>{agenda.title} 근거 자료</DialogTitle></DialogHeader>
          <DialogPanel className="pas-rb-evidence-panel">
            <EvidenceChart agenda={agenda} large />
            {agenda.caveat ? <p className="pas-rb-caveat"><EyeOff className="size-4" strokeWidth={1.5} aria-hidden="true" /><span>못 본 범위: {agenda.caveat}</span></p> : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </section>
  </div>;
}
