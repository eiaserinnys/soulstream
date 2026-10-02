import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { CardDetail } from '../api/cardTypes';
import { cardFixture } from '../test-support/cards';
import { CardTimeline } from '../components/planner/CardTimeline';
import { UserMessage } from '../components/events/UserMessage';
import { AttachmentImage } from '../components/AttachmentImage';
import { Asset } from 'expo-asset';
import { useTokens } from '../theme';

/** Local public fixture using the production timeline and chat attachment. */
export function ReviewCardImages({ serverUrl, bundledImages = false }: { serverUrl: string; bundledImages?: boolean }) {
  const t = useTokens();
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
  return <ScrollView testID="card-image-review" style={{ flex: 1, backgroundColor: t.colors.background }}
    contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.uiSpacing.lg }} showsVerticalScrollIndicator={false}>
    <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>공개 fixture · RN web 배치와 조작 검수입니다. 네이티브 인증은 별도 계약으로 확인합니다.</Text>
    <View testID="review-image-timeline"><CardTimeline detail={detail} onChooseAnswer={() => {}} /></View>
    <View testID="review-unchanged-chat">
      <UserMessage event={{ id: 'public-chat', type: 'user_message', data: { text: '기존 채팅 첨부 비교', attachments: bundledImages ? [] : ['/review/one.png'], node_id: 'public-node' } }}>
        {bundledImages ? <AttachmentImage source={require('../../assets/icon.png')} accessibilityLabel="기존 채팅 첨부" /> : null}
      </UserMessage>
    </View>
  </ScrollView>;
}
