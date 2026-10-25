import { useState } from 'react';
import type { PersistentReportEntry } from '@seosoyoung/soul-ui';
import type { CardDetail } from '@seosoyoung/soul-ui/cards/card-types';
import { reviewCard, reviewCardItems, reviewNow, reviewDetail } from './components-review-fixtures';
import { PasCardExpansion, PasCardExpansionStatus } from './PasCardExpansion';

export const pasPreviewCard = { ...reviewCard, id: 'preview-pas-card', number: 531, status: 'review' as const,
  title: 'PAS 판에서 결과와 증거를 확인하고 담당에게 커멘트까지 남기는 화면',
  now: { ...reviewNow, text: '웹과 앱의 제자리 펼침 시안을 준비했습니다.', ask: '화면과 증거를 확인해 주세요.' },
  items: [
    { ...reviewCardItems[2], id: 1, title: '판 안에서 결과와 증거를 읽습니다', result: '제목을 누르면 같은 자리에서 펼쳐집니다.' },
    { ...reviewCardItems[2], id: 2, title: '담당에게 바로 커멘트를 남깁니다', result: 'PAS 대화를 떠나지 않고 글을 보냅니다.', evidence: [{ type: 'image' as const, url: '/icon-512.png', label: '입력 화면' }] },
    { ...reviewCardItems[0], id: 3, title: '실기기 화면 확인', caveat: 'iPhone 실기기에서는 아직 확인하지 못했습니다.' },
  ],
};
export const pasSecondPreviewCard = { ...pasPreviewCard, id: 'preview-pas-card-2', number: 532, title: '두 번째 검수 카드' };
export const pasPreviewEntries: (PersistentReportEntry & { card_id: string; card_status: 'review' | 'blocked' })[] = [
  { key: 'card_preview-pas-card', kind: 'see', title: 'PAS 판에서 결과와 증거를 확인하고 담당에게 커멘트까지 남기는 화면'.slice(0, 24) + '…',
    card_numbers: [531], card_id: pasPreviewCard.id, card_status: 'review', context: pasPreviewCard.now.ask, action: '', options: [], state: 'open', answer: '', updated_at: 'preview' },
  { key: 'cq_preview-question', question_id: 'preview-question', kind: 'ask', title: '입력 위치 확인', card_numbers: [531],
    card_id: pasPreviewCard.id, card_status: 'blocked', context: '추가 커멘트를 장 안에서 바로 쓸까요?', action: '', options: ['장 안에서', '카드에서'], state: 'open', answer: '', updated_at: 'preview' },
];

export function PasCardPreviewStatus({ entry }: { entry: PersistentReportEntry }) {
  return <PasCardExpansionStatus entry={entry} />;
}

export function PasCardPreview({ entry, lookupCards, onAnswer }: {
  entry: PersistentReportEntry;
  lookupCards: () => Promise<void>;
  onAnswer(answer: string): void;
}) {
  const card = entry.card_id === pasSecondPreviewCard.id ? pasSecondPreviewCard : pasPreviewCard;
  const [detail, setDetail] = useState<CardDetail>(() => ({
    ...reviewDetail,
    card,
    comments: [
      { cardId: card.id, authorId: '', sessionId: null, kind: 'comment', createdAt: '2026-10-05T08:00:00Z', id: 'preview-user', authorKind: 'user', body: 'PAS 안에서 결과를 읽고 의견도 남기고 싶어요.' },
      { cardId: card.id, authorId: 'roselin', sessionId: null, kind: 'comment', id: 'preview-agent', authorKind: 'agent', body: '결과와 증거를 장 안에 모았습니다.', createdAt: '2026-10-05T08:01:00Z' },
    ],
    questions: entry.question_id ? [{ id: entry.question_id, text: entry.title, options: null, answer: null, askedAt: '2026-10-05T08:00:00Z', answeredAt: null }] : [],
  }));
  return <PasCardExpansion entry={entry} lookupCards={lookupCards} sampleDetail={detail} samplePortraitUrl="/system-portrait.png" onSampleChange={setDetail} onAnswer={onAnswer} />;
}
