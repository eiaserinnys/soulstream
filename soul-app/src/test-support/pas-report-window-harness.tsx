// 카드 #1871: 보고 창 시험이 함께 쓰는 마운트 도구. jest.mock은 각 시험 파일이 건다(windowDims를 화면 폭으로 쓴다).
import React from 'react';
import { act, render, within } from '@testing-library/react-native';
import type { CardDetail, CardDto } from '../api/cardTypes';
import { CARD_QUESTION_KEY_PREFIX } from '../../../packages/wire-schema/src/persistent_report';
import { fakeServer, reportEntry, type FakeServer } from './pas-report';
import { useCardStore } from '../store/cardStore';
import type { CardCompletion } from '../components/persistent/usePersistentCardCompletion';
import { PasReportWindow, type PasReportWindowHandle } from '../components/pasReport/PasReportWindow';

export const windowDims = { width: 390, height: 844, scale: 1, fontScale: 1 };
export type Completion = CardCompletion & { complete: jest.Mock; undo: jest.Mock };
export const completionStub = (patch: Partial<CardCompletion> = {}): Completion => ({
  recent: null, busy: false, complete: jest.fn(async () => true), undo: jest.fn(async () => true), ...patch,
}) as Completion;

export const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
export const labels = (container: ReturnType<typeof within>) => container.queryAllByRole('button').map(button => button.props.accessibilityLabel as string);

export interface Options {
  cards: CardDto[];
  details?: Record<string, Partial<CardDetail>>;
  entries: ReturnType<typeof reportEntry>[];
  startCardId?: string | null;
  completion?: Completion;
  width?: number;
  server?: FakeServer;
  dismissReport?: jest.Mock;
}

export function mount(options: Options) {
  const server = options.server ?? fakeServer(options.cards, options.details);
  for (const card of options.cards) useCardStore.getState().putCard(card);
  const completion = options.completion ?? completionStub();
  const ref = React.createRef<PasReportWindowHandle>();
  const props = {
    api: server.api, completion, startCardId: options.startCardId ?? null,
    dismissReport: options.dismissReport ?? jest.fn(async () => true), onClose: jest.fn(), onOpenCard: jest.fn(), onLayersChange: jest.fn(),
  };
  const view = (entries: Options['entries']) => <PasReportWindow ref={ref} {...props} entries={entries} />;
  windowDims.width = options.width ?? 390;
  const screen = render(view(options.entries));
  return { screen, server, completion, props, ref, rerender: (entries: Options['entries']) => screen.rerender(view(entries)) };
}

export function resetCards() {
  useCardStore.setState({ rows: {}, seq: 0, rowSeq: {}, listTicket: {}, details: {}, pendingItemConfirmations: {} });
}

export const reviewEntry = (id: string, number: number, patch = {}) => reportEntry({ key: `card_${id}`, card_id: id, card_numbers: [number], title: `${number}번 카드`, ...patch });
export const questionEntry = (id: string, number: number, questionId = 'q1', patch = {}) => reportEntry({
  key: `${CARD_QUESTION_KEY_PREFIX}${questionId}`, card_id: id, card_numbers: [number], card_status: 'blocked', kind: 'ask',
  question_id: questionId, question_kind: 'choice', title: `${number}번 질문`, ...patch });

