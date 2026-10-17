import type { ApiClient } from '../api/client';
import { ApiHttpError } from '../api/clientCore';
import { AttachmentReadError } from '../api/attachmentEndpoints';
import type { AttachmentDescriptor, AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';

export function buildAttachmentReviewApi(api: Partial<ApiClient>): ApiClient {
  return {
    ...api,
    getAttachmentMetadata: async (attachmentId: string, _readContext: AttachmentReadContext) => {
      if (attachmentId === 'review-attachment-network') throw new TypeError('공개 표본: 연결 실패');
      const status = attachmentReviewFailureStatus(attachmentId);
      if (status !== null) throw metadataHttpError(status);
      const descriptor = attachmentReviewDescriptor(attachmentId);
      if (!descriptor) throw metadataHttpError(404);
      return { descriptor, upload_status: 'committed' };
    },
    readAttachmentText: async (attachmentId: string) => {
      const status = attachmentReviewFailureStatus(attachmentId);
      if (status !== null) throw attachmentReadError(status);
      if (attachmentId === 'review-attachment-long') return { text: Array.from({ length: 300 }, (_, index) => `${index + 1}: 공개 검수용 서버 로그`).join('\n'), truncated: false };
      if (attachmentId === 'review-attachment-empty') return { text: '', truncated: false };
      if (attachmentId === 'review-attachment-markdown') return { text: '# 평문으로 표시되는 Markdown', truncated: false };
      if (attachmentId === 'review-attachment-json') return { text: '{\n  "ready": true\n}', truncated: false };
      if (!attachmentReviewDescriptor(attachmentId)) throw attachmentReadError(404);
      return { text: '공개 검수용 TXT 내용입니다.', truncated: false };
    },
  } as unknown as ApiClient;
}

function attachmentReviewFailureStatus(attachmentId: string): number | null {
  if (attachmentId === 'review-attachment-denied') return 403;
  if (attachmentId === 'review-card-missing' || attachmentId === 'review-attachment-missing') return 404;
  if (attachmentId === 'review-attachment-retryable') return 503;
  return null;
}

function metadataHttpError(status: number): ApiHttpError {
  return new ApiHttpError(`[getAttachmentMetadata] HTTP ${status}`, status, '');
}

function attachmentReadError(status: number): AttachmentReadError {
  if (status === 403) return new AttachmentReadError('denied', status);
  if (status === 404) return new AttachmentReadError('not-found', status);
  return new AttachmentReadError('retryable', status);
}

function attachmentReviewDescriptor(attachmentId: string): AttachmentDescriptor | null {
  const entries: Record<string, Omit<AttachmentDescriptor, 'attachment_id'>> = {
    'review-card-image-two': reviewImageDescriptor('카드 두번째 화면.png'),
    'review-card-image': {
      name: '카드 화면.png', mime_type: 'image/png', byte_size: 1_593_049, checksum_sha256: null,
      width: 64, height: 64, preview_kind: 'image', preview_mime_type: 'image/png',
    },
    'review-card-text': {
      name: '카드 설명.txt', mime_type: 'text/plain', byte_size: 37, checksum_sha256: null,
      width: null, height: null, preview_kind: 'text', preview_mime_type: 'text/plain',
    },
    'review-card-report': {
      name: '보고 설명.txt', mime_type: 'text/plain', byte_size: 37, checksum_sha256: null,
      width: null, height: null, preview_kind: 'text', preview_mime_type: 'text/plain',
    },
    'review-image-one': reviewImageDescriptor('표본 첫 이미지.png'),
    'review-image-two': reviewImageDescriptor('표본 둘째 이미지.png'),
    'review-image-single': reviewImageDescriptor('표본 한 장 이미지.png'),
    'review-attachment-text': reviewTextDescriptor('메모.txt', 348),
    'review-attachment-markdown': reviewTextDescriptor('README.md', 2_048),
    'review-attachment-json': reviewTextDescriptor('설정.json', 1_200),
    'review-attachment-empty': reviewTextDescriptor('빈 파일.txt', 0),
    'review-attachment-long': reviewTextDescriptor('수백 줄 서버 로그와 아주 긴 파일 이름을 가진 공개 검수용 첨부 문서.txt', 12_000),
    'review-attachment-bin': reviewInfoDescriptor('archive.bin', 'application/octet-stream', 4_096),
    'review-attachment-svg': reviewInfoDescriptor('vector.svg', 'image/svg+xml', 1_536),
    'review-attachment-heic': reviewInfoDescriptor('photo.heic', 'image/heic', 3_072),
  };
  const descriptor = entries[attachmentId];
  return descriptor ? { attachment_id: attachmentId, ...descriptor } : null;
}

function reviewImageDescriptor(name: string): Omit<AttachmentDescriptor, 'attachment_id'> {
  return {
    name, mime_type: 'image/png', byte_size: 1_048_576, checksum_sha256: null,
    width: 64, height: 64, preview_kind: 'image', preview_mime_type: 'image/png',
  };
}

function reviewTextDescriptor(name: string, byteSize: number): Omit<AttachmentDescriptor, 'attachment_id'> {
  return {
    name, mime_type: 'text/plain', byte_size: byteSize, checksum_sha256: null,
    width: null, height: null, preview_kind: 'text', preview_mime_type: 'text/plain',
  };
}

function reviewInfoDescriptor(name: string, mimeType: string, byteSize: number): Omit<AttachmentDescriptor, 'attachment_id'> {
  return {
    name, mime_type: mimeType, byte_size: byteSize, checksum_sha256: null,
    width: null, height: null, preview_kind: 'info', preview_mime_type: null,
  };
}
