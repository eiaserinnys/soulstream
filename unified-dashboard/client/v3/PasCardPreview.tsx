import { useState } from 'react';
import { Button, type PersistentReportEntry } from '@seosoyoung/soul-ui';
import type { CardDetail } from '@seosoyoung/soul-ui/cards/card-types';
import { reviewCard, reviewCardItems, reviewNow, reviewDetail } from './components-review-fixtures';
import { CardNowPanel } from './CardNowPanel';
import { CardCheckItems } from './CardCheckItems';
import { CardTimeline } from './CardTimeline';
import { CardCommentInput } from './CardCommentInput';
import { CardStatusChip } from './CardActions';

export const pasPreviewCard = { ...reviewCard, id: 'preview-pas-card', number: 531, status: 'review' as const,
  title: 'PAS 판에서 결과와 증거를 확인하고 담당에게 커멘트까지 남기는 화면',
  now: { ...reviewNow, text: '웹과 앱의 제자리 펼침 시안을 준비했습니다.', ask: '화면과 증거를 확인해 주세요.' },
  items: [
    { ...reviewCardItems[2], id: 1, title: '판 안에서 결과와 증거를 읽습니다', result: '제목을 누르면 같은 자리에서 펼쳐집니다.' },
    { ...reviewCardItems[2], id: 2, title: '담당에게 바로 커멘트를 남깁니다', result: 'PAS 대화를 떠나지 않고 글을 보냅니다.', evidence: [{ type: 'image' as const, url: '/icon-512.png', label: '입력 화면' }] },
    { ...reviewCardItems[0], id: 3, title: '실기기 화면 확인', caveat: 'iPhone 실기기에서는 아직 확인하지 못했습니다.' },
  ],
};
export const pasPreviewEntries: (PersistentReportEntry & { card_id: string; card_status: 'review' | 'blocked' })[] = [
  { key: 'card_preview-pas-card', kind: 'see', title: 'PAS 판에서 결과와 증거를 확인하고 담당에게 커멘트까지 남기는 화면'.slice(0, 24) + '…',
    card_numbers: [531], card_id: pasPreviewCard.id, card_status: 'review', context: pasPreviewCard.now.ask, action: '', options: [], state: 'open', answer: '', updated_at: 'preview' },
  { key: 'cq_preview-question', question_id: 'preview-question', kind: 'ask', title: '입력 위치 확인', card_numbers: [531],
    card_id: pasPreviewCard.id, card_status: 'blocked', context: '추가 커멘트를 장 안에서 바로 쓸까요?', action: '', options: ['장 안에서', '카드에서'], state: 'open', answer: '', updated_at: 'preview' },
];
export function PasCardPreviewStatus({ entry }: { entry: PersistentReportEntry }) {
  return <CardStatusChip card={{ ...pasPreviewCard, status: entry.key.startsWith('cq_') ? 'blocked' : 'review', blockedKind: entry.key.startsWith('cq_') ? 'question' : null }} />;
}
export function PasCardPreview({ entry, onAnswer }: { entry: PersistentReportEntry; onAnswer(answer: string): void }) {
  const [focusRequest, setFocusRequest] = useState(0);
  const [items, setItems] = useState(pasPreviewCard.items);
  const [comments, setComments] = useState(() => [
    { cardId: pasPreviewCard.id, authorId: null, sessionId: null, kind: 'comment' as const, createdAt: '2026-10-05T08:00:00Z', id: 'preview-user', authorKind: 'user' as const, body: 'PAS 안에서 결과를 읽고 의견도 남기고 싶어요.' },
    { cardId: pasPreviewCard.id, authorId: null, sessionId: null, kind: 'comment' as const, id: 'preview-agent', authorKind: 'agent' as const, body: '결과와 증거를 장 안에 모았습니다.', createdAt: '2026-10-05T08:01:00Z' },
  ]);
  const question = entry.key.startsWith('cq_');
  const card = { ...pasPreviewCard, items };
  const detail: CardDetail = { ...reviewDetail, card, reports: [], questions: [], comments: comments.slice(-2) };
  return <div className="pas-report-card-preview" data-testid="pas-card-preview">
    <CardNowPanel embedded now={card.now} itemsCount={items.length} activeCount={items.filter(item => item.display !== 'confirmed').length} />
    <CardCheckItems items={items} onConfirmChange={async (id, confirmed) => {
      setItems(current => current.map(item => item.id === id ? { ...item, display: confirmed ? 'confirmed' : 'reported', confirmed: confirmed ? { at: card.updatedAt, rev: item.rev } : null } : item));
    }} onTargetItem={() => setFocusRequest(saved => saved + 1)} />
    <CardTimeline card={card} detail={detail} portraitUrl="/system-portrait.png" commentsOnly pending={false} onAnswer={() => {}} />
    <Button variant="link" render={<a href="/?card=preview-pas-card" onClick={event => event.preventDefault()} />}>카드 열기</Button>
    <CardCommentInput focusRequest={focusRequest} cardId={entry.key} pending={false} placeholder={question ? '질문에 답하기' : '커멘트'} onSend={async body => {
      if (question) onAnswer(body);
      else setComments(current => [...current, { ...current[0], id: String(current.length), body, createdAt: new Date().toISOString(), authorKind: 'user' }]);
      return true;
    }} />
  </div>;
}
