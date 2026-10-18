import React from 'react';
import { Asset } from 'expo-asset';
import { ScrollView } from 'react-native';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import type { AttachmentView } from '../lib/attachment-view';
import type { SessionEvent } from '../api/types';
import { MessageAttachments } from '../components/MessageAttachments';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { ThinkingEvent } from '../components/events/ThinkingEvent';
import { ToolEvent } from '../components/events/ToolEvent';
import { useTokens } from '../theme';
import { ReviewSection } from './ReviewSection';

const readContext: AttachmentReadContext = { type: 'owner' };
const iconUri = Asset.fromModule(require('../../assets/icon.png')).uri;
const symbolUri = Asset.fromModule(require('../../assets/icon-symbol.png')).uri;

const multipleImages = [
  image('review-image-one', '표본 첫 이미지.png', iconUri),
  image('review-image-two', '표본 둘째 이미지.png', symbolUri),
];
const singleImage = [image('review-image-single', '표본 한 장 이미지.png', iconUri)];
const failedImage = [image('review-image-failed', '불러오지 못하는 이미지.png', '/component-review/missing-attachment-image.png')];
const truncatedAttachment = {
  attachment_id: 'review-truncation-full',
  name: '전체 도구 결과.txt',
  mime_type: 'text/plain',
  byte_size: 1_234_567,
  checksum_sha256: null,
  width: null,
  height: null,
  preview_kind: 'text' as const,
  preview_mime_type: 'text/plain',
};
const truncation = { original_bytes: 1_234_567, attachment: truncatedAttachment };
const toolStart: SessionEvent = {
  id: 'review-truncation-start',
  type: 'tool_start',
  data: { tool_name: 'Read', tool_input: '파일을 읽습니다.' },
};
const toolStartTruncated: SessionEvent = {
  id: 'review-truncation-start-attached',
  type: 'tool_start',
  data: {
    tool_name: 'Read',
    tool_input: '파일을 읽습니다.\n[잘림]',
    truncation,
  },
};
const toolResult = (attachment: typeof truncatedAttachment | null): SessionEvent => ({
  id: 'review-truncation-result',
  type: 'tool_result',
  data: {
    result: '도구 결과의 앞부분입니다.\n[잘림]',
    truncation: { original_bytes: truncation.original_bytes, attachment },
  },
});
const thinkingEvent = (id: string, attachment: typeof truncatedAttachment | null): SessionEvent => ({
  id,
  type: 'thinking_delta',
  data: {
    thinking: '생각 앞부분입니다.\n[잘림]',
    truncation: { original_bytes: truncation.original_bytes, attachment },
  },
});

const fileItems: AttachmentView[] = [
  textFile('review-attachment-text', '메모.txt', 348),
  textFile('review-attachment-markdown', 'README.md', 2048),
  textFile('review-attachment-json', '설정.json', 1200),
  textFile('review-attachment-empty', '빈 파일.txt', 0),
  unavailableFile('review-attachment-missing', '첨부 없음.txt'),
  textFile('review-attachment-denied', '권한 없음.txt', 820),
  textFile('review-attachment-retryable', '일시 오류.txt', 512),
  infoFile('review-attachment-bin', 'archive.bin', 'application/octet-stream', 4096),
  infoFile('review-attachment-svg', 'vector.svg', 'image/svg+xml', 1536),
  infoFile('review-attachment-heic', 'photo.heic', 'image/heic', 3072),
];

const htmlItem = infoFile('review-attachment-html', '공개 검수용 문서.html', 'text/html', 10_401);

const mixedItems = [multipleImages[0], textFile('review-attachment-long', '수백 줄 서버 로그와 아주 긴 파일 이름을 가진 공개 검수용 첨부 문서.txt', 12_000), multipleImages[1], fileItems[7]];
export const attachmentDialogueItems = mixedItems;

export function ReviewAttachments() {
  const t = useTokens();
  return <ScrollView testID="review-attachments" style={{ flex: 1, backgroundColor: t.colors.background }}
    contentContainerStyle={{ padding: t.foundation.pageInset, gap: t.uiSpacing.lg }} showsVerticalScrollIndicator={false}>
    <ReviewSection title="이미지 여러 장" testID="review-attachments-multiple">
      <MessageAttachments items={multipleImages} role="user" />
    </ReviewSection>
    <ReviewSection title="이미지 한 장" testID="review-attachments-single">
      <MessageAttachments items={singleImage} role="assistant" />
    </ReviewSection>
    <ReviewSection title="실패한 이미지" testID="review-attachments-image-failure">
      <MessageAttachments items={failedImage} role="user" />
    </ReviewSection>
    {(['user', 'assistant', 'manuscript'] as const).map(kind => <ReviewSection key={kind}
      title={kind === 'user' ? '사용자 혼합 첨부' : kind === 'assistant' ? '에이전트 혼합 첨부' : '원고형 혼합 첨부'}
      testID={`review-attachments-mixed-${kind}`}>
      <MessageAttachments items={mixedItems} role={kind === 'user' ? 'user' : 'assistant'} presentation={kind === 'manuscript' ? 'manuscript' : 'default'} />
    </ReviewSection>)}
    <ReviewSection title="파일 행과 프리뷰" testID="review-attachments-files">
      <MessageAttachments items={fileItems} role="assistant" />
    </ReviewSection>
    <ReviewSection title="HTML 문서" testID="review-attachments-html">
      <MessageAttachments items={[htmlItem]} role="assistant" />
    </ReviewSection>
    <ReviewSection title="이미지와 HTML 문서 혼합" testID="review-attachments-html-mixed">
      <MessageAttachments items={[multipleImages[0], htmlItem]} role="assistant" />
    </ReviewSection>
    <ReviewSection title="도구 결과 잘림 · 전문 보관" testID="review-attachments-truncation-attached">
      <ToolEvent start={toolStartTruncated} result={toolResult(truncatedAttachment)} sessionId="review-truncation" api={null} />
    </ReviewSection>
    <ReviewSection title="도구 결과 잘림 · 보관 실패" testID="review-attachments-truncation-failed">
      <ToolEvent start={toolStart} result={toolResult(null)} sessionId="review-truncation" api={null} />
    </ReviewSection>
    <ReviewSection title="에이전트 응답 잘림" testID="review-attachments-truncation-assistant">
      <AssistantMessage event={{
        id: 'review-truncation-assistant',
        type: 'assistant_message',
        data: {
          content: '에이전트 응답의 앞부분입니다.\n[잘림]',
          attachment_ids: [truncatedAttachment.attachment_id],
          truncation,
        },
      }} sessionId="review-truncation" />
    </ReviewSection>
    <ReviewSection title="생각 잘림 · 기본형 · 전문 보관" testID="review-attachments-truncation-thinking-default-attached">
      <ThinkingEvent event={thinkingEvent('review-truncation-thinking-default-attached', truncatedAttachment)} sessionId="review-truncation" />
    </ReviewSection>
    <ReviewSection title="생각 잘림 · 기본형 · 보관 실패" testID="review-attachments-truncation-thinking-default-failed">
      <ThinkingEvent event={thinkingEvent('review-truncation-thinking-default-failed', null)} sessionId="review-truncation" />
    </ReviewSection>
    <ReviewSection title="생각 잘림 · 원고형 · 전문 보관" testID="review-attachments-truncation-thinking-manuscript-attached">
      <ThinkingEvent presentation="manuscript" event={thinkingEvent('review-truncation-thinking-manuscript-attached', truncatedAttachment)} sessionId="review-truncation" />
    </ReviewSection>
    <ReviewSection title="생각 잘림 · 원고형 · 보관 실패" testID="review-attachments-truncation-thinking-manuscript-failed">
      <ThinkingEvent presentation="manuscript" event={thinkingEvent('review-truncation-thinking-manuscript-failed', null)} sessionId="review-truncation" />
    </ReviewSection>
  </ScrollView>;
}

function image(key: string, name: string, previewUrl: string): AttachmentView {
  return {
    key,
    name,
    mimeType: 'image/png',
    byteSize: 1_048_576,
    previewKind: 'image',
    readContext,
    source: { kind: 'ready', attachmentId: key, previewUrl, originalUrl: previewUrl },
  };
}

function textFile(key: string, name: string, byteSize: number): AttachmentView {
  return {
    key,
    name,
    mimeType: 'text/plain',
    byteSize,
    previewKind: 'text',
    readContext,
    source: { kind: 'ready', attachmentId: key, previewUrl: null, originalUrl: `/api/attachments/${key}/content?download=true` },
  };
}

function infoFile(key: string, name: string, mimeType: string, byteSize: number): AttachmentView {
  return { ...textFile(key, name, byteSize), mimeType, previewKind: 'info' };
}

function unavailableFile(key: string, name: string): AttachmentView {
  return {
    key,
    name,
    mimeType: 'text/plain',
    byteSize: null,
    previewKind: 'text',
    readContext,
    source: { kind: 'unavailable', availability: 'missing' },
  };
}
