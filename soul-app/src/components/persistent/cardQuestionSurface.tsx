// 카드 #1197: PAS 판의 질문 장 칩 글과 질문 면을 운영 화면과 검수 표본이 함께 쓴다.
// 표본이 이 함수를 그대로 타야 운영과 표본이 갈라지지 않는다(화면 계약 4절 마지막 문장).
import React from 'react';
import { Text } from 'react-native';
import type { ApiClient } from '../../api/client';
import type { CardMutationResult } from '../../api/cardTypes';
import type { PersistentReportEntry } from '../../api/types';
import type { DesignTokens } from '../../theme';
import { cardOperationId } from '../../hooks/useCardActions';
import { formatCardTime } from '../../lib/card-check-item-summary';
import { CARD_QUESTION_KEY_PREFIX } from '../../../../packages/wire-schema/src/persistent_report';
import {
  answerCardQuestionChoice, CardQuestionActions, CardQuestionAnswered, CardQuestionBody,
  setCardQuestionTarget, type CardQuestionTarget,
} from '../planner/CardQuestionBlock';
import { cardQuestionViewFromEntry, type CardQuestionView } from '../planner/card-question-viewmodel';
import type { CardQuestionAnswerHold } from './usePersistentReport';

/** 카드 상태 칩 옆에 붙는 질문 장 글. 선택 질문은 「카드 질문」, 부탁 장은 「카드 부탁」이다. */
export function cardQuestionChipLabel(entry: PersistentReportEntry, blockedKind: string | null | undefined) {
  return blockedKind === 'question' && entry.question_kind
    ? entry.question_kind === 'request' ? '카드 부탁' : '카드 질문'
    : undefined;
}

export type CardQuestionSurfaceDeps = {
  t: DesignTokens;
  api: ApiClient | null;
  portraitUri: string | null;
  questionActions: { run(mutation: () => Promise<CardMutationResult>): Promise<boolean>; pending: boolean };
  reportSend: { busy: boolean; sendOption(entry: PersistentReportEntry, option: string): void };
  answerHold: CardQuestionAnswerHold;
};

/** 펼친 장이 카드 상세를 읽었으면 계약 1.4절 「상세에서」 보기를 controls.detailView로 넘긴다. */
export type CardQuestionSurfaceControls = { expanded: boolean; expand(): void; detailView?: CardQuestionView | null };

export type CardQuestionSurface = { meta?: React.ReactNode; body: React.ReactNode; actions: React.ReactNode };

export function renderCardQuestionSurface(entry: PersistentReportEntry, controls: CardQuestionSurfaceControls,
  deps: CardQuestionSurfaceDeps): CardQuestionSurface | null {
  if (!entry.key.startsWith(CARD_QUESTION_KEY_PREFIX) && !entry.question_id) return null;
  const { t } = deps;
  const view = controls.detailView ?? cardQuestionViewFromEntry(entry);
  const targetKey = entry.card_id ?? entry.key;
  const cardId = entry.card_id ?? null;
  const questionId = entry.question_id;
  const busy = controls.expanded ? deps.questionActions.pending : deps.reportSend.busy;
  const choose = (label: string) => {
    // 접힌 장은 지금의 판 답 경로({key, option})를 그대로 쓴다. 펼친 장은 카드 REST로 보낸다.
    if (!controls.expanded || !deps.api || !cardId || !questionId) { deps.reportSend.sendOption(entry, label); return; }
    // 보내기 시작과 함께 장을 잠정으로 붙들어, 판 갱신이 응답보다 먼저 와도 펼친 영역이 내려가지 않게 한다.
    deps.answerHold.begin(entry, label);
    // 저장이 성공한 뒤에만 확정하고 덧붙이기 대상을 세운다(화면 계약 판 5, 3절 15번, 코드 감수 P1-1).
    void answerCardQuestionChoice(targetKey, questionId, label, () => deps.questionActions.run(
      () => deps.api!.answerCardQuestion(cardId, questionId, { mode: 'choice', option: label, idempotencyKey: cardOperationId() }),
    )).then(saved => {
      if (saved) deps.answerHold.confirm(entry, label);
      else deps.answerHold.release(entry);
    });
  };
  const expandWith = (target: CardQuestionTarget | null) => { controls.expand(); setCardQuestionTarget(targetKey, target, true); };
  return {
    meta: view.revisedAt ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>{`${formatCardTime(view.revisedAt)}에 고침`}</Text> : undefined,
    body: <CardQuestionBody view={view} cardId={targetKey} portraitUri={deps.portraitUri} onChoose={choose} busy={busy} surface="pas" />,
    actions: view.open
      ? <CardQuestionActions view={view} composerVisible={controls.expanded} busy={busy}
          onAnswerFreely={() => expandWith(null)}
          onAskBack={() => { if (questionId) expandWith({ kind: 'ask', questionId }); }}
          onDone={() => choose('했어')} />
      : <CardQuestionAnswered view={view} onAppend={() => {
          if (questionId) expandWith({ kind: 'append', questionId, label: view.selectedOption ?? view.answer ?? '' });
        }} />,
  };
}
