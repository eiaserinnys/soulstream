import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { CardAttachmentAssetEvidence, CardCheckItem, CardDetail } from '../api/cardTypes';
import { cardFixture } from '../test-support/cards';
import { CardTimeline } from '../components/planner/CardTimeline';
import { CardCheckItems } from '../components/planner/CardCheckItems';
import { UserMessage } from '../components/events/UserMessage';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { AttachmentImage } from '../components/AttachmentImage';
import { Asset } from 'expo-asset';
import { useTokens } from '../theme';
import { attachmentContentUrl } from '../lib/attachment-view';
import { ContentLinkProvider } from '../navigation/ContentLinkProvider';
import { CardCreateSheet } from '../components/planner/CardCreateSheet';
import { GlassButton } from '../components/GlassSurface';

/** Local public fixture using the production timeline and chat attachment. */
export function ReviewCardImages({ serverUrl, bundledImages = false }: { serverUrl: string; bundledImages?: boolean }) {
  const t = useTokens();
  const [showCreatePreview, setShowCreatePreview] = useState(false);
  const url = (name: string) => '/api/attachments/files?' + new URLSearchParams({ nodeId: 'public-node', path: '/review/' + name + '.png' });
  // The normal gallery uses bundled public assets, without replacing its auth.
  // The local HTTP entry keeps protected fixture routes for contract capture.
  const firstAsset = bundledImages ? new URL(Asset.fromModule(require('../../assets/icon.png')).uri, serverUrl) : null;
  const relative = firstAsset ? firstAsset.pathname + firstAsset.search : url('one');
  const absolute = bundledImages ? new URL(Asset.fromModule(require('../../assets/icon-symbol.png')).uri, serverUrl).href : serverUrl + url('two');
  const third = firstAsset ? firstAsset.href : serverUrl.replace('127.0.0.1', 'localhost') + '/public-image.png';
  const at = '2026-10-02T00:00:00Z';
  const card = cardFixture({ id: 'review-images', request: '공개 이미지 검수', status: 'done', assigneeAgentId: null, nodeId: 'public-node', createdAt: at });
  const detail: CardDetail = { card, sessions: [], questions: [], reports: [{
    id: 'public-images', cardId: card.id, title: '공개 보고', format: 'markdown', createdAt: at,
    body: `이미지 두 장을 미리 보고, 펼치면 문단 순서대로 읽습니다.\n\n![첫 이미지](${relative})\n\n두 이미지 사이의 문단입니다.\n\n![둘째 이미지](${absolute})\n\n![${bundledImages ? '세번째 이미지' : '외부 이미지'}](${third})\n\n마지막 문단입니다.`,
  }], comments: [
    { id: 'web-relative', cardId: card.id, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment',
      body: `웹에서 저장한 상대 URL 커멘트\n\n![웹 첨부](${relative})`, createdAt: '2026-10-02T00:01:00Z' },
    { id: 'app-absolute', cardId: card.id, authorKind: 'user', authorId: null, sessionId: null, kind: 'comment',
      body: `앱에서 저장한 절대 URL 커멘트\n\n![앱 첨부](${absolute})`, createdAt: '2026-10-02T00:02:00Z' },
  ] };
  const widthCard = cardFixture({ id: 'report-width', request: '보고를 펼쳐 읽어 주세요.', status: 'review', assigneeAgentId: null, createdAt: at });
  const widthDetail: CardDetail = { card: widthCard, sessions: [],
    questions: [{ id: 'width-question', cardId: widthCard.id, sessionId: 'public-session', text: '확인해 주시겠습니까?', options: null, answer: null, askedAt: at }],
    reports: [{ id: 'width-report', cardId: widthCard.id, title: '이미지 없는 보고', format: 'markdown', createdAt: at,
      body: '**이미지 없는 한국어 보고입니다.** 자세히를 눌러도 질문과 같은 넓은 말풍선 안에서 본문을 읽을 수 있어야 합니다.\n\n접힌 보고와 펼친 보고의 가로 폭을 비교합니다. 다시 접은 뒤에도 폭과 아바타, 본문 여백이 그대로 유지되는지 확인합니다.' }],
    comments: [{ id: 'width-comment', cardId: widthCard.id, authorKind: 'agent', authorId: null, sessionId: null, kind: 'comment', body: '확인했습니다.', createdAt: at }],
  };
  const attachmentCard = cardFixture({ id: 'review-card-attachments', request: '카드 첨부 검수', status: 'review', assigneeAgentId: null, nodeId: 'public-node', createdAt: at });
  const cardContext = { type: 'card' as const, id: attachmentCard.id };
  const cardContentUrl = (id: string, download = false) => attachmentContentUrl(id, cardContext, { download });
  const cardAsset = (id: string, name: string, previewKind: 'image' | 'text', type: 'image' | 'link' = 'image'): CardAttachmentAssetEvidence => ({
    type,
    label: name,
    url: cardContentUrl(id),
    attachment_id: id,
    descriptor: {
      attachment_id: id,
      name,
      mime_type: previewKind === 'image' ? 'image/png' : 'text/plain',
      byte_size: previewKind === 'image' ? 1593049 : 37,
      checksum_sha256: null,
      width: previewKind === 'image' ? 64 : null,
      height: previewKind === 'image' ? 64 : null,
      preview_kind: previewKind,
      preview_mime_type: previewKind === 'image' ? 'image/png' : 'text/plain',
    },
    read_context: cardContext,
    previewUrl: previewKind === 'image' ? (id === 'review-card-image-two' ? absolute : firstAsset?.href ?? null) : null,
    originalUrl: cardContentUrl(id, true),
  });
  const evidence: CardCheckItem = {
    id: 1,
    title: '화면 캡처',
    state: 'done',
    result: null,
    evidence: [
      cardAsset('review-card-image', '카드 화면.png', 'image'),
      cardAsset('review-card-image-two', '카드 두번째 화면.png', 'image'),
      cardAsset('review-card-text', '카드 설명.txt', 'text', 'link'),
      cardAsset('review-attachment-denied', '권한 없는 파일.txt', 'text', 'link'),
      cardAsset('review-attachment-retryable', '다시 읽을 파일.txt', 'text', 'link'),
      { type: 'image', url: '', label: '없는 파일.png', attachment_id: 'review-card-missing',
        read_context: cardContext, availability: 'missing', previewUrl: null, originalUrl: '' },
      { type: 'image', url: url('legacy-card-image'), label: 'legacy-card-image.png' },
      { type: 'link', url: 'https://example.invalid/card-reference', label: '외부 참고 링크' },
    ],
    caveat: null,
    rev: 1,
    confirmed: null,
    fixOpen: 0,
    reopened: null,
    from: null,
    createdAt: at,
    reportedAt: at,
    display: 'reported',
  };
  const attachmentReport: CardDetail = {
    card: attachmentCard,
    sessions: [],
    questions: [],
    reports: [{ id: 'card-attachment-report', cardId: attachmentCard.id, title: '첨부가 있는 보고', format: 'markdown', createdAt: at,
      body: `카드 보고 본문 내부 파일입니다: [보고 설명.txt](${cardContentUrl('review-card-report')})` }],
    comments: [],
  };
  return <ContentLinkProvider><ScrollView testID="card-image-review" style={{ flex: 1, backgroundColor: t.colors.background }}
    contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.uiSpacing.lg }} showsVerticalScrollIndicator={false}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>공개 fixture · RN web 배치와 조작 검수입니다. 네이티브 인증은 별도 계약으로 확인합니다.</Text>
    <View testID="card-evidence-fixture" style={{ gap: t.uiSpacing.sm }}>
      <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>카드 증거 첨부</Text>
      <CardCheckItems cardId={attachmentCard.id} items={[evidence]} pendingConfirmations={{}} initiallyConfirmedIds={[]} newlyConfirmedIds={[]}
        onConfirm={async () => true} onSetTarget={() => {}} onRecentConfirmation={() => {}} paneWidth={680} />
    </View>
    <View testID="card-body-attachment-fixture" style={{ gap: t.uiSpacing.sm }}>
      <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>카드 보고 본문</Text>
      <CardTimeline detail={attachmentReport} onChooseAnswer={() => {}} />
    </View>
    <View testID="card-create-preview-fixture" style={{ gap: t.uiSpacing.sm }}>
      <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>카드 만들기 미리보기</Text>
      <GlassButton accessibilityLabel="새 카드 작성 표본 열기" size="card" onPress={() => setShowCreatePreview(true)}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>새 카드 작성</Text>
      </GlassButton>
    </View>
    <View testID="review-report-width"><CardTimeline detail={widthDetail} onChooseAnswer={() => {}} /></View>
    <View testID="review-image-timeline"><CardTimeline detail={detail} onChooseAnswer={() => {}} /></View>
    <View testID="review-unchanged-chat">
      <UserMessage event={{ id: 'public-chat', type: 'user_message', data: { text: '기존 채팅 첨부 비교', attachments: bundledImages ? [] : ['/review/one.png'], node_id: 'public-node' } }}>
        {bundledImages ? <AttachmentImage source={require('../../assets/icon.png')} accessibilityLabel="기존 채팅 첨부" /> : null}
      </UserMessage>
      <AssistantMessage event={{ id: 'public-short-message', type: 'assistant_message', data: { text: '확인했습니다.' } }} />
    </View>
  </ScrollView>
    {showCreatePreview ? <CardCreateSheet api={null} folderId="public-project" onClose={() => setShowCreatePreview(false)} /> : null}
  </ContentLinkProvider>;
}
