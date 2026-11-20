import type { AttachmentReadContext } from '../../../../packages/wire-schema/src/attachments';
import type { AttachmentView } from '../../../src/lib/attachment-view';

// Public check fixtures. Content that the modal reads by attachment id comes from
// the review fixture API (?section=attachments) so the real read path runs.
const readContext: AttachmentReadContext = { type: 'owner' };

function image(key: string, name: string, mimeType: string, previewUrl: string): AttachmentView {
  return {
    key,
    name,
    mimeType,
    byteSize: 1_048_576,
    previewKind: 'image',
    readContext,
    source: { kind: 'ready', attachmentId: key, previewUrl, originalUrl: previewUrl },
  };
}

function file(
  key: string,
  name: string,
  mimeType: string | null,
  byteSize: number,
  previewKind: 'text' | 'info',
  extra: Partial<AttachmentView> = {},
): AttachmentView {
  return {
    key,
    name,
    mimeType,
    byteSize,
    previewKind,
    readContext,
    source: { kind: 'ready', attachmentId: key, previewUrl: null, originalUrl: `/api/attachments/${key}/content?download=true` },
    ...extra,
  };
}

/** Fails once, then serves the retried body. The flow opens it exactly once. */
function failingThenReadyText(): (signal: AbortSignal) => Promise<{ text: string; truncated: boolean }> {
  let attempts = 0;
  return async () => {
    attempts += 1;
    if (attempts === 1) throw { kind: 'retryable' };
    return { text: '다시 시도로 불러온 본문입니다.\n두 번째 줄입니다.', truncated: false };
  };
}

export function attachmentPreviewHarnessItems(): AttachmentView[] {
  return [
    image('harness-image-raster', '현장 사진.png', 'image/png', '/fixtures/raster.png'),
    image('harness-image-svg', '도면.svg', 'image/svg+xml', '/fixtures/vector.svg'),
    file('harness-pdf', '회의록.pdf', 'application/pdf', 245_760, 'info', {
      source: { kind: 'ready', attachmentId: 'harness-pdf', previewUrl: null, originalUrl: '/fixtures/pdf-pages.html' },
    }),
    file('review-attachment-long', '수백 줄 서버 로그와 아주 긴 파일 이름을 가진 공개 검수용 첨부 문서.txt', 'text/plain', 12_000, 'text'),
    file('review-attachment-markdown', '톤 제안 원문.md', 'text/markdown', 2_048, 'text'),
    file('review-attachment-html', '공개 검수용 문서.html', 'text/html', 10_401, 'info'),
    file('harness-zip', '묶음자료.zip', 'application/zip', 31_457, 'info'),
    file('review-attachment-empty', '빈 메모.txt', 'text/plain', 0, 'text'),
    file('harness-loading', '받는 중인 기록.txt', 'text/plain', 12_000, 'text', {
      loadText: () => new Promise<{ text: string; truncated: boolean }>(() => {}),
    }),
    file('harness-failure', '불러오지 못하는 기록.txt', 'text/plain', 900, 'text', {
      loadText: async () => { throw { kind: 'retryable' }; },
    }),
    file('harness-retry', '다시 시도할 기록.txt', 'text/plain', 512, 'text', {
      loadText: failingThenReadyText(),
    }),
  ];
}
