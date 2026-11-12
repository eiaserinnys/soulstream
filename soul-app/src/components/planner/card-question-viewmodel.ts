import type { CardComment, CardQuestion } from '../../api/cardTypes';
import type { PersistentReportEntry } from '../../api/types';
import type { CardQuestionAttachment, CardQuestionKind, CardQuestionOption } from '../../../../packages/wire-schema/src/card_questions';

export type CardQuestionViewOption = { label: string; description: string | null; recommended: boolean };

export type CardQuestionViewThread = { id: string; author: 'user' | 'agent'; body: string; at: string };

/**
 * 카드 질문 장의 보기 모델. 화면 계약 1.4절.
 * 질문 장 부품은 원천(카드 상세, PAS 장)을 모르고 이 보기만 받는다.
 */
export type CardQuestionView = {
  id: string;
  title: string | null;
  background: string;
  kind: CardQuestionKind;
  options: CardQuestionViewOption[];
  attachments: CardQuestionAttachment[];
  thread: CardQuestionViewThread[];
  open: boolean;
  selectedOption: string | null;
  answer: string | null;
  /** revision이 2 이상일 때만 채운다. */
  revisedAt: string | null;
  awaitingAgent: boolean;
};

function viewOptions(
  details: readonly CardQuestionOption[] | null | undefined,
  labels: readonly string[] | null | undefined,
): CardQuestionViewOption[] {
  const source: readonly CardQuestionOption[] = details?.length ? details : (labels ?? []).map(label => ({ label }));
  return source.map(option => ({
    label: option.label,
    description: option.description ?? null,
    recommended: option.recommended === true,
  }));
}

function closedAt(revisedAt: string | null | undefined, revision: number | undefined): string | null {
  return (revision ?? 1) >= 2 ? revisedAt ?? null : null;
}

function awaiting(open: boolean, thread: readonly CardQuestionViewThread[]): boolean {
  return open && thread.length > 0 && thread[thread.length - 1].author === 'user';
}

/** 선택 답 칸이 없던 옛 답은 받은 글이 선택지 이름과 같을 때만 고른 것으로 읽는다. */
function selectedFromAnswer(
  selectedOption: string | null | undefined,
  answer: string | null,
  options: readonly CardQuestionViewOption[],
): string | null {
  if (selectedOption !== undefined) return selectedOption;
  if (answer === null) return null;
  return options.some(option => option.label === answer) ? answer : null;
}

/**
 * 카드 상세에서 보기로.
 * cardTitle은 화면 계약 1.4의 호출 꼴을 지키기 위해 받는다. 1.1에 따라 옛 질문은
 * 카드 상세에서 제목 줄을 생략하므로 제목을 카드 제목으로 채우지 않는다.
 */
export function cardQuestionViewFromDetail(
  question: CardQuestion,
  comments: readonly CardComment[],
  cardTitle: string,
): CardQuestionView {
  const options = viewOptions(question.optionDetails, question.options);
  const answer = question.answer ?? null;
  const open = answer === null && !question.withdrawnAt;
  const thread = comments
    .filter(comment => comment.questionId === question.id)
    .sort((a, b) => a.createdAt === b.createdAt
      ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      : a.createdAt < b.createdAt ? -1 : 1)
    .map(comment => ({
      id: comment.id,
      author: comment.authorKind,
      body: comment.body,
      at: comment.createdAt,
    }));
  return {
    id: question.id,
    title: question.title ?? null,
    background: question.text,
    kind: question.kind ?? 'choice',
    options,
    attachments: question.attachments ?? [],
    thread,
    open,
    selectedOption: selectedFromAnswer(question.selectedOption, answer, options),
    answer,
    revisedAt: closedAt(question.revisedAt, question.revision),
    awaitingAgent: awaiting(open, thread),
  };
}

/** PAS 판의 질문 장에서 보기로. 질문 칸이 없는 옛 장은 장 제목과 배경으로 대신한다. */
export function cardQuestionViewFromEntry(entry: PersistentReportEntry): CardQuestionView {
  const options = viewOptions(entry.question_option_details, entry.options);
  const open = entry.state === 'open';
  const answer = open ? null : entry.answer || null;
  const thread = (entry.question_thread ?? []).map(turn => ({
    id: turn.id,
    author: turn.author_kind,
    body: turn.body,
    at: turn.created_at,
  }));
  return {
    id: entry.question_id ?? entry.key,
    title: entry.question_title ?? entry.title,
    background: entry.question_text ?? entry.context,
    kind: entry.question_kind ?? 'choice',
    options,
    attachments: entry.question_attachments ?? [],
    thread,
    open,
    selectedOption: selectedFromAnswer(undefined, answer, options),
    answer,
    revisedAt: closedAt(entry.question_revised_at, entry.question_revision),
    awaitingAgent: awaiting(open, thread),
  };
}
