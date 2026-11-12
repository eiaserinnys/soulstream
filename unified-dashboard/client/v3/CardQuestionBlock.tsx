// 카드 #1197: 질문 장 「결정 한 장」의 본문과 동작 줄. PAS 판 장과 카드 상세 커멘트 탭이
// 같은 부품을 쓴다(ui-design §6). 화면 계약 1.4의 보기 모델만 받고, 실제 필드 이름은
// cardQuestionDetailView와 cardQuestionSheetView가 만든다.
import { useState, type ReactNode } from "react";
import { ThinkingOrb } from "@seosoyoung/soul-ui/components/chat/WorkingOrb";
import { Badge, Button, MarkdownContent, type PersistentReportEntry } from "@seosoyoung/soul-ui";
import { InputRequestOptionContent } from "@seosoyoung/soul-ui/components/InputRequestOptionContent";
import { MarkdownImage } from "@seosoyoung/soul-ui/components/MarkdownImage";
import { ProfileAvatar } from "@seosoyoung/soul-ui/components/ProfileAvatar";
import type { CardComment, CardQuestion } from "@seosoyoung/soul-ui/cards/card-types";
type CardQuestionAttachment = NonNullable<CardQuestion["attachments"]>[number];
import { Link } from "lucide-react";
import { CardImageViewer } from "./CardImageViewer";
import "./v3-card-check-items.css";
import "./card-question.css";

export type CardQuestionView = {
  id: string;
  title: string | null;
  background: string;
  kind: "choice" | "request";
  options: { label: string; description: string | null; recommended: boolean }[];
  attachments: CardQuestionAttachment[];
  thread: { id: string; author: "user" | "agent"; body: string; at: string }[];
  open: boolean;
  selectedOption: string | null;
  answer: string | null;
  revisedAt: string | null;
  awaitingAgent: boolean;
};

export function isOpenCardQuestion(question: CardQuestion) {
  return question.answer === null && question.answeredAt === null && !question.withdrawnAt;
}

function questionOptions(details: CardQuestion["optionDetails"], labels: CardQuestion["options"]) {
  const list: { label: string; description?: string | null; recommended?: boolean }[] =
    details?.length ? details : (labels ?? []).map(label => ({ label }));
  return list.map(option => ({ label: option.label, description: option.description ?? null, recommended: option.recommended === true }));
}

function revisedTime(revisedAt: string | null | undefined, revision: number | null | undefined) {
  return (revision ?? 1) >= 2 && revisedAt ? revisedAt : null;
}

export function cardQuestionDetailView(question: CardQuestion, comments: readonly CardComment[], _cardTitle: string): CardQuestionView {
  const thread = comments
    .filter(comment => comment.questionId === question.id && comment.kind !== "note")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
    .map(comment => ({ id: comment.id, author: comment.authorKind, body: comment.body, at: comment.createdAt }));
  const open = isOpenCardQuestion(question);
  return {
    id: question.id,
    title: question.title?.trim() || null,
    background: question.text,
    kind: question.kind === "request" ? "request" : "choice",
    options: questionOptions(question.optionDetails, question.options),
    attachments: question.attachments ?? [],
    thread,
    open,
    selectedOption: question.selectedOption ?? null,
    answer: open ? null : question.answer,
    revisedAt: revisedTime(question.revisedAt, question.revision),
    awaitingAgent: open && thread.at(-1)?.author === "user",
  };
}

export function cardQuestionSheetView(entry: PersistentReportEntry): CardQuestionView {
  const options = questionOptions(entry.question_option_details, entry.options);
  const thread = [...(entry.question_thread ?? [])]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id))
    .map(turn => ({ id: turn.id, author: turn.author_kind, body: turn.body, at: turn.created_at }));
  const open = (entry.state ?? "open") === "open";
  const answer = open ? null : entry.answer || null;
  return {
    id: entry.question_id ?? entry.key,
    title: entry.question_title?.trim() || entry.title,
    background: entry.question_text ?? entry.context,
    kind: entry.question_kind === "request" ? "request" : "choice",
    options,
    attachments: entry.question_attachments ?? [],
    thread,
    open,
    selectedOption: answer ? options.find(option => option.label === answer)?.label ?? null : null,
    answer,
    revisedAt: revisedTime(entry.question_revised_at, entry.question_revision),
    awaitingAgent: open && thread.at(-1)?.author === "user",
  };
}

type BodyProps = {
  view: CardQuestionView;
  portraitUrl: string | null;
  userPortraitUrl?: string | null;
  pending?: boolean;
  /** 좁은 장(PAS 판, 휴대폰 폭)에서는 선택지 설명을 이름 아래에 쌓는다. */
  layout?: "columns" | "stack";
  onChoose?(label: string): void;
};

export function CardQuestionBody({ view, portraitUrl, userPortraitUrl, pending = false, layout = "stack", onChoose }: BodyProps) {
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  const images = view.attachments.filter(item => item.type === "image");
  const links = view.attachments.filter(item => item.type === "link");
  const choices = view.kind === "request" ? [] : view.options;
  return <div className="v3-card-question-body" data-question-kind={view.kind} data-open={view.open || undefined}>
    <div className="v3-card-question-background"><MarkdownContent content={view.background} /></div>
    {images.length ? <div className="v3-card-check-item-evidence" data-evidence-type="image">{images.map((item, index) =>
      <figure key={`${item.url}:${index}`} title={item.label}>
        <MarkdownImage variant="card-evidence" src={item.previewUrl ?? item.url} alt={item.label} onOpen={(src, alt) => setImage({ src, alt })} />
      </figure>)}</div> : null}
    {links.length ? <div className="v3-card-check-item-links" data-evidence-type="link">{links.map((item, index) =>
      <a key={`${item.url}:${index}`} href={item.url} target="_blank" rel="noreferrer" title={item.label}><Link className="h-3 w-3" aria-hidden="true" />{item.label}</a>)}</div> : null}
    {view.thread.length ? <ol className="v3-card-question-thread" aria-label="되묻기">
      {view.thread.map(turn => <li key={turn.id} data-author={turn.author}>
        <ProfileAvatar role={turn.author === "user" ? "user" : "assistant"} hasPortrait fallbackEmoji={turn.author === "user" ? "👤" : "🤖"} portraitUrl={turn.author === "user" ? userPortraitUrl : portraitUrl} />
        <div className="v3-card-question-turn"><MarkdownContent content={turn.body} /></div>
      </li>)}
      {view.awaitingAgent ? <li data-author="agent" data-waiting="true" aria-label="담당의 답을 기다리는 중">
        <ProfileAvatar role="assistant" hasPortrait fallbackEmoji="🤖" portraitUrl={portraitUrl} />
        <div className="v3-card-question-turn"><ThinkingOrb state="working" size={20} theme="auto" aria-hidden="true" /><span className="v3-card-question-meta">답을 기다리는 중</span></div>
      </li> : null}
    </ol> : null}
    {choices.length ? <div className="v3-card-question-choices" role="group" aria-label="선택지">
      {choices.map(choice => {
        const chosen = !view.open && view.selectedOption === choice.label;
        return <Button key={choice.label} variant="choice" className="w-full px-3 py-2.5" disabled={!view.open || pending}
          data-selected={chosen ? "true" : undefined} aria-pressed={chosen || undefined} onClick={() => onChoose?.(choice.label)}>
          <InputRequestOptionContent layout={layout} option={{ label: choice.label, description: choice.description ?? undefined }}
            descriptionClassName="v3-card-question-effect"
            labelAccessory={choice.recommended ? <Badge variant="info" size="sm" className="v3-card-question-recommended">권함</Badge> : null} />
        </Button>;
      })}
    </div> : null}
    <CardImageViewer image={image} attachments={[]} onClose={() => setImage(null)} />
  </div>;
}

type ActionsProps = {
  view: CardQuestionView;
  pending?: boolean;
  onAnswerFreely(): void;
  onAskBack(): void;
  onDone?(): void;
  /** 아래 입력창이 보이는 자리(펼친 장, 카드 상세)에서는 입력창 자체가 「다르게 답하기」라 단추를 두지 않는다. */
  composerVisible?: boolean;
};

/** 늘 있는 두 동작. 부탁 장은 「했어」 하나가 더 붙는다. */
export function CardQuestionActions({ view, pending = false, onAnswerFreely, onAskBack, onDone, composerVisible = false }: ActionsProps) {
  if (!view.open) return null;
  return <div className="chat-ui-actions v3-card-question-actions">
    {composerVisible ? null : <Button variant="outline" disabled={pending} onClick={onAnswerFreely}>다르게 답하기</Button>}
    <Button variant="outline" disabled={pending} onClick={onAskBack}>되묻기</Button>
    {view.kind === "request" ? <Button variant="default" disabled={pending} onClick={onDone}>했어</Button> : null}
  </div>;
}

/** 답을 보낸 뒤의 줄: 받은 답과 「덧붙이기」. 덧붙인 말은 같은 질문에 이어진 커멘트로 간다. */
export function CardQuestionAnswered({ view, onAppend }: { view: CardQuestionView; onAppend?(): void }) {
  if (view.open || !view.answer) return null;
  return <div className="v3-card-question-answered">
    <span className="pas-report-received-label">받은 답</span><span className="v3-card-question-answer">{view.answer}</span>
    {onAppend ? <Button variant="ghost" size="xs" onClick={onAppend}>덧붙이기</Button> : null}
  </div>;
}

export function CardQuestionNotice({ label, onClear }: { label: ReactNode; onClear(): void }) {
  return <div className="v3-card-target-notice" role="status"><span>{label}</span><button type="button" onClick={onClear}>해제</button></div>;
}
