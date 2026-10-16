import React from 'react';
import { Asset } from 'expo-asset';
import { ScrollView } from 'react-native';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import type { AttachmentView } from '../lib/attachment-view';
import { MessageAttachments } from '../components/MessageAttachments';
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
    <ReviewSection title="파일 행과 프리뷰" testID="review-attachments-files">
      <MessageAttachments items={fileItems} role="assistant" />
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
