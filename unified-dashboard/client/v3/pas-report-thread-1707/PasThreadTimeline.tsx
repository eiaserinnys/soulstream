import { Fragment } from "react";
import { Button, Checkbox } from "@seosoyoung/soul-ui";
import { FileText, Maximize2 } from "lucide-react";
import { CardQuestionAnswered, CardQuestionBody, type CardQuestionView } from "../CardQuestionBlock";
import { EvidenceArt } from "./EvidenceArt";
import {
  AGENT_NAMES,
  agentPortraitUrl,
  type Agenda,
  type CheckItem,
  type Evidence,
  type QuestionSeed,
  type ThreadEvent,
} from "./pas-report-thread-1707-data";

function phaseOf(event: ThreadEvent): number {
  if (event.kind === "request") return 1;
  if (event.kind === "result") return 4;
  if (event.kind === "comment") return 3;
  return 2;
}

function eventTitle(event: ThreadEvent, afterComment: boolean): string {
  if (event.kind === "request") return "디렉터 원 요청";
  if (event.kind === "result") return "확인할 결과와 증거";
  if (event.kind === "comment") return event.author === "user" ? "디렉터 커멘트" : `${AGENT_NAMES[event.agent!]} 커멘트`;
  return afterComment ? "담당 세션 답글" : "담당 세션 경과";
}

export function questionView(question: QuestionSeed, answer: string | null, open: boolean): CardQuestionView {
  return {
    id: question.id,
    title: question.title,
    background: question.background,
    kind: question.kind,
    options: question.options,
    attachments: [],
    thread: [],
    open,
    selectedOption: answer,
    answer,
    revisedAt: null,
    awaitingAgent: false,
  };
}

export function PasThreadTimeline({ agenda, checks, questionAnswer, onToggleCheck, onInstruct, onOpenEvidence, onOpenDocument, onOpenCard }: {
  agenda: Agenda;
  checks: Readonly<Record<string, boolean>>;
  questionAnswer: string | null;
  onToggleCheck(agendaId: string, checkId: string): void;
  onInstruct(agenda: Agenda, check: CheckItem): void;
  onOpenEvidence(evidence: Evidence, trigger: HTMLElement | null): void;
  onOpenDocument(documentId: string): void;
  onOpenCard(trigger: HTMLElement | null): void;
}) {
  let sawComment = false;
  let maxPhase = 0;
  const hasComment = agenda.events.some((event) => event.kind === "comment");
  return <div className="pas-rt1707-timeline" role="list" aria-label={`${agenda.number}번 안건의 시간순 기록`}>
    {agenda.events.map((event) => {
      const afterComment = sawComment;
      if (event.kind === "comment") sawComment = true;
      const rawPhase = event.kind === "session" && afterComment ? 3 : phaseOf(event);
      const phase = Math.max(maxPhase, rawPhase);
      maxPhase = phase;
      return <Fragment key={event.id}>
        {event.kind === "result" && !hasComment ? <section className="pas-rt1707-event" data-kind="silence" role="listitem">
          <span className="pas-rt1707-event-number" aria-hidden="true">3</span>
          <div className="pas-rt1707-event-body">
            <header className="pas-rt1707-event-head"><h3>3. 중간 커멘트 없음</h3></header>
          </div>
        </section> : null}
        <section className="pas-rt1707-event" data-kind={event.kind} role="listitem">
        <span className="pas-rt1707-event-number" aria-hidden="true">{phase}</span>
        <div className="pas-rt1707-event-body">
          <header className="pas-rt1707-event-head">
            <h3>{`${phase}. ${eventTitle(event, afterComment)}`}</h3>
            <time>{event.at}</time>
          </header>
          {event.kind === "request" ? <p className="pas-rt1707-request" data-v3-selectable-content="true">{event.text}</p> : null}
          {event.kind === "session" ? <SessionEvent event={event} /> : null}
          {event.kind === "comment" ? <CommentEvent event={event} /> : null}
          {event.kind === "result" ? <ResultEvent agenda={agenda} event={event} checks={checks} questionAnswer={questionAnswer}
            onToggleCheck={onToggleCheck} onInstruct={onInstruct} onOpenEvidence={onOpenEvidence} onOpenDocument={onOpenDocument} onOpenCard={onOpenCard} /> : null}
        </div>
        </section>
      </Fragment>;
    })}
  </div>;
}

function SessionEvent({ event }: { event: Extract<ThreadEvent, { kind: "session" }> }) {
  return <div className="pas-rt1707-session">
    <div className="pas-rt1707-session-head">
      <img className="pas-rt1707-session-portrait" src={agentPortraitUrl(event.agent)} alt="" width={32} height={32} />
      <strong>{AGENT_NAMES[event.agent]}</strong>
      <span className="pas-rt1707-session-role">담당 세션</span>
    </div>
    <p className="pas-rt1707-session-summary" data-v3-selectable-content="true">{event.summary}</p>
    {event.turns.length > 0 ? <details className="pas-rt1707-turns">
      <summary>세션 발화 {event.turns.length}턴 펼쳐 보기</summary>
      <ol>
        {event.turns.map((turn) => <li key={turn.id} data-role={turn.role}>
          <span className="pas-rt1707-turn-speaker">{turn.role === "assistant" ? AGENT_NAMES[event.agent] : "위임자"}</span>
          <p data-v3-selectable-content="true">{turn.text}</p>
        </li>)}
      </ol>
    </details> : null}
  </div>;
}

function CommentEvent({ event }: { event: Extract<ThreadEvent, { kind: "comment" }> }) {
  return <div className="pas-rt1707-comment" data-author={event.author}>
    {event.author === "agent" && event.agent ? <img src={agentPortraitUrl(event.agent)} alt="" width={24} height={24} /> : null}
    <div>
      <strong className="pas-rt1707-comment-author">{event.author === "user" ? "디렉터" : AGENT_NAMES[event.agent!]}</strong>
      <p data-v3-selectable-content="true">{event.text}</p>
    </div>
  </div>;
}

function ResultEvent({ agenda, event, checks, questionAnswer, onToggleCheck, onInstruct, onOpenEvidence, onOpenDocument, onOpenCard }: {
  agenda: Agenda;
  event: Extract<ThreadEvent, { kind: "result" }>;
  checks: Readonly<Record<string, boolean>>;
  questionAnswer: string | null;
  onToggleCheck(agendaId: string, checkId: string): void;
  onInstruct(agenda: Agenda, check: CheckItem): void;
  onOpenEvidence(evidence: Evidence, trigger: HTMLElement | null): void;
  onOpenDocument(documentId: string): void;
  onOpenCard(trigger: HTMLElement | null): void;
}) {
  return <div className="pas-rt1707-result">
    <div className="pas-rt1707-summary"><strong>결과 보고 요약</strong><p data-v3-selectable-content="true">{event.summaryReport}</p></div>
    {agenda.kind === "ui" ? <div className="pas-rt1707-document-row"><Button variant="outline" size="sm" onClick={(event) => onOpenCard(event.currentTarget)}>카드 패널에서 변경 파일 보기</Button></div> : null}
    <ul className="pas-rt1707-checks">
      {event.checks.map((check) => <li key={check.id} className="pas-rt1707-check">
        <Checkbox checked={checks[`${agenda.id}:${check.id}`] ?? check.done} onCheckedChange={() => onToggleCheck(agenda.id, check.id)}
          aria-label={check.label} />
        <span className="pas-rt1707-check-label" data-v3-selectable-content="true">{check.label}</span>
        <Button variant="ghost" size="xs" className="pas-rt1707-check-instruct" onClick={() => onInstruct(agenda, check)}
          aria-label={`${agenda.number}번 ${check.label} 항목에 지시하기`}>항목 지시</Button>
      </li>)}
    </ul>
    <figure className="pas-rt1707-evidence">
      <button type="button" className="pas-rt1707-evidence-button" onClick={(click) => onOpenEvidence(event.evidence, click.currentTarget)}
        aria-label={`${event.evidence.label} 확대해서 보기`}>
        <EvidenceArt evidence={event.evidence} />
        <span className="pas-rt1707-evidence-more">확대 <Maximize2 className="size-4" strokeWidth={1.4} aria-hidden="true" /></span>
      </button>
      <figcaption data-v3-selectable-content="true">{event.evidence.caption}</figcaption>
    </figure>
    {agenda.documentId ? <div className="pas-rt1707-document-row">
      <Button variant="outline" size="sm" onClick={() => onOpenDocument(agenda.documentId!)}>
        <FileText className="size-4" strokeWidth={1.4} aria-hidden="true" />설계 문서 열람
      </Button>
    </div> : null}
    {agenda.question?.kind === "request" ? <div className="pas-rt1707-question">
      <CardQuestionBody key={`${agenda.id}:${questionAnswer ?? "open"}`} view={questionView(agenda.question, questionAnswer, questionAnswer === null)}
        portraitUrl={agentPortraitUrl(agenda.agent)} layout="stack" />
      {questionAnswer !== null ? <CardQuestionAnswered view={questionView(agenda.question, questionAnswer, false)} /> : null}
    </div> : null}
    {event.caveat ? <div className="pas-rt1707-caveat"><strong>못 본 범위</strong><p data-v3-selectable-content="true">{event.caveat}</p></div> : null}
  </div>;
}
