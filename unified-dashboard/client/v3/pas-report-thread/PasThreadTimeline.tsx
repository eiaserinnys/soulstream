import { useState } from "react";
import { Badge, Button, FrameLoading, useAgentPortraitUrlResolver, useAuth } from "@seosoyoung/soul-ui";
import { InputRequestOptionContent } from "@seosoyoung/soul-ui/components/InputRequestOptionContent";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import type { CardComment, CardDetail, CardQuestion } from "@seosoyoung/soul-ui/cards/card-types";
import { ChevronDown, ChevronUp } from "lucide-react";
import { CardCheckItems } from "../CardCheckItems";
import { CardQuestionAnswered, CardQuestionBody, cardQuestionDetailView } from "../CardQuestionBlock";
import { CardTimeline } from "../CardTimeline";
import { buildThread, type Agenda, type ThreadItem } from "./pas-report-thread-model";
import type { PasReportThreadController } from "./use-pas-report-thread";

const EMPTY_PENDING: Readonly<Record<number, boolean>> = {};

function clockText(at: number, now: number) {
  const date = new Date(at), today = new Date(now);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return date.toDateString() === today.toDateString() ? hhmm : `${date.getMonth() + 1}/${date.getDate()} ${hhmm}`;
}

/** 카드 상세를 기다리거나 실패했을 때도 스레드 자리가 같은 틀을 지킨다. */
export function PasThreadBody({ controller, agenda }: { controller: PasReportThreadController; agenda: Agenda }) {
  const { detail, loadState } = controller;
  if (!detail) {
    return loadState === "error"
      ? <div className="pas-rt-thread-state" role="alert" data-testid="pas-rt-thread-error">
        <p>카드를 불러오지 못했습니다.</p>
        <Button variant="outline" onClick={controller.retry}>다시 시도</Button>
      </div>
      : <div className="pas-rt-thread-state" data-testid="pas-rt-thread-loading"><FrameLoading label="카드를 불러오는 중" /></div>;
  }
  return <PasThreadTimeline controller={controller} agenda={agenda} detail={detail} />;
}

function PasThreadTimeline({ controller, agenda, detail }: { controller: PasReportThreadController; agenda: Agenda; detail: CardDetail }) {
  const { user } = useAuth();
  const resolvePortrait = useAgentPortraitUrlResolver();
  const card = detail.card;
  const portraitUrl = card.assigneeAgent?.portraitUrl ?? (resolvePortrait(card.assigneeAgentId) || null);
  const userPortraitUrl = user?.picture ?? "";
  const items = buildThread(detail);
  const cardItems = card.items ?? [];
  const pendingConfirmations = useCardStore(state => state.pendingItemConfirmations[card.id] ?? EMPTY_PENDING);
  const withoutLines: CardDetail = { ...detail, comments: [], notes: [], questions: [], reports: [] };
  return <div className="pas-rt-timeline" role="list" aria-label={`${agenda.number ?? ""}번 안건의 시간순 기록`} data-testid="pas-rt-timeline">
    {items.map(item => <section key={item.id} className="pas-rt-event" data-kind={item.kind} role="listitem">
      {item.kind === "request" ? <CardTimeline card={card} detail={withoutLines} portraitUrl={portraitUrl} userPortraitUrl={userPortraitUrl} pending={false} onAnswer={() => {}} /> : null}
      {item.kind === "milestone" ? <Milestone item={item} now={controller.now} /> : null}
      {item.kind === "comments" ? <CardTimeline card={card} detail={{ ...withoutLines, comments: item.comments }} portraitUrl={portraitUrl} userPortraitUrl={userPortraitUrl}
        commentsOnly pending={false} onAnswer={() => {}} /> : null}
      {item.kind === "question" ? <QuestionBlock detail={detail} question={item.question}
        portraitUrl={portraitUrl} userPortraitUrl={userPortraitUrl} /> : null}
      {item.kind === "notes" ? <Notes notes={item.notes} now={controller.now} /> : null}
    </section>)}
    {cardItems.length ? <section className="pas-rt-event pas-rt-items" data-kind="items" role="listitem" aria-label="확인 항목">
      <CardCheckItems items={cardItems} pendingConfirmations={pendingConfirmations}
        onConfirmChange={(itemId, confirmed) => useCardStore.getState().confirmItem(card.id, itemId, confirmed).then(() => undefined)}
        onTargetItem={itemId => controller.setTarget({ itemId, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null })} />
    </section> : null}
  </div>;
}

function Milestone({ item, now }: { item: Extract<ThreadItem, { kind: "milestone" }>; now: number }) {
  return <p className="pas-rt-milestone" data-tone={item.tone}>
    <span className="pas-rt-milestone-dot" aria-hidden="true" />
    <span className="pas-rt-milestone-text" data-v3-selectable-content="true">{item.text}</span>
    <time dateTime={new Date(item.at).toISOString()}>{clockText(item.at, now)}</time>
  </p>;
}

function Notes({ notes, now }: { notes: CardComment[]; now: number }) {
  const [open, setOpen] = useState(false);
  return <div className="pas-rt-notes" data-open={open || undefined}>
    <button type="button" className="pas-rt-notes-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      기술 기록 {notes.length}건{open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
    </button>
    {open ? <ul className="pas-rt-notes-list">
      {notes.map(note => <li key={note.id}><time dateTime={note.createdAt}>{clockText(Date.parse(note.createdAt), now)}</time>
        <span data-v3-selectable-content="true">{note.body}</span></li>)}
    </ul> : null}
  </div>;
}

/**
 * 열린 선택 질문의 선택지는 결재 상자 알약 한 곳에서만 고른다. 스레드는 제목, 배경, 되묻기 글타래와
 * 선택지 설명을 읽기 전용으로 보인다. 답한 질문과 철회된 질문은 정본 모양(고른 선택지 표시) 그대로다.
 */
function QuestionBlock({ detail, question, portraitUrl, userPortraitUrl }: {
  detail: CardDetail; question: CardQuestion; portraitUrl: string | null; userPortraitUrl: string;
}) {
  const view = cardQuestionDetailView(question, detail.comments ?? [], "");
  const withdrawn = Boolean(question.withdrawnAt);
  const readonlyOptions = view.open && view.kind === "choice" ? view.options : [];
  return <div className="pas-rt-question" data-open={view.open || undefined} data-withdrawn={withdrawn || undefined}>
    {view.title ? <h3 className="v3-card-question-title">{view.title}</h3> : null}
    <CardQuestionBody view={readonlyOptions.length ? { ...view, options: [] } : view} portraitUrl={portraitUrl} userPortraitUrl={userPortraitUrl} pending layout="stack" />
    {readonlyOptions.length ? <ul className="pas-rt-question-options" aria-label="선택지 설명" data-testid="pas-rt-question-options" data-v3-selectable-content="true">
      {readonlyOptions.map(option => <li key={option.label}>
        <InputRequestOptionContent layout="stack" option={{ label: option.label, description: option.description ?? undefined }}
          descriptionClassName="v3-card-question-effect"
          labelAccessory={option.recommended ? <Badge variant="info" size="sm" className="v3-card-question-recommended">권함</Badge> : null} />
      </li>)}
    </ul> : null}
    {withdrawn && question.withdrawalReason ? <p className="v3-card-question-withdrawal">{question.withdrawalReason}</p> : null}
    {!view.open ? <CardQuestionAnswered view={view} /> : null}
  </div>;
}
