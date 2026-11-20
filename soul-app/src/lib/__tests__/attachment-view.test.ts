import type { CardAttachmentAssetEvidence } from '../../api/cardTypes';
import {
  attachmentContentUrl,
  isHtmlAttachmentView,
  isLegacyAttachmentImage,
  isMarkdownAttachmentView,
  isPdfAttachmentView,
  isSvgAttachmentImage,
  isSvgImageMimeType,
  isSvgImageName,
  isSvgImageUri,
  toCardAttachmentView,
} from '../attachment-view';

const descriptor = {
  attachment_id: 'asset/1',
  name: '화면.png',
  mime_type: 'image/png',
  byte_size: 0,
  checksum_sha256: null,
  width: 120,
  height: 80,
  preview_kind: 'image',
  preview_mime_type: 'image/webp',
} as const;

const readyEvidence: CardAttachmentAssetEvidence = {
  type: 'image',
  label: '결과 화면',
  url: '/api/attachments/asset%2F1/content?context_type=card&context_id=card%2F1',
  attachment_id: 'asset/1',
  descriptor,
  read_context: { type: 'card', id: 'card/1' },
  previewUrl: '/api/attachments/asset%2F1/content?context_type=card&context_id=card%2F1',
  originalUrl: '/api/attachments/asset%2F1/content?context_type=card&context_id=card%2F1&download=true',
};

test('카드 C-10 이미지 descriptor를 공통 표시 모델로 보존한다', () => {
  expect(toCardAttachmentView(readyEvidence)).toEqual({
    key: 'asset/1',
    name: '화면.png',
    mimeType: 'image/png',
    byteSize: 0,
    previewKind: 'image',
    readContext: { type: 'card', id: 'card/1' },
    source: {
      kind: 'ready',
      attachmentId: 'asset/1',
      previewUrl: readyEvidence.previewUrl,
      originalUrl: readyEvidence.originalUrl,
    },
  });
});

test('누락 카드 evidence는 label과 원래 위치를 보존하고 저장 URL을 만들지 않는다', () => {
  const missing: CardAttachmentAssetEvidence = {
    type: 'link',
    label: '결과 파일.txt',
    url: '',
    attachment_id: 'asset/missing',
    read_context: { type: 'card', id: 'card/1' },
    availability: 'missing',
    previewUrl: null,
    originalUrl: '',
  };

  expect(toCardAttachmentView(missing)).toEqual({
    key: 'asset/missing',
    name: '결과 파일.txt',
    mimeType: null,
    byteSize: null,
    previewKind: 'info',
    readContext: { type: 'card', id: 'card/1' },
    source: { kind: 'unavailable', availability: 'missing' },
  });
});

test('인증 context와 download만 URL에 포함하고 인증값은 넣지 않는다', () => {
  expect(attachmentContentUrl('asset/1', { type: 'session', id: 'session 1' }))
    .toBe('/api/attachments/asset%2F1/content?context_type=session&context_id=session+1');
  expect(attachmentContentUrl('asset/1', { type: 'card', id: 'card/1' }, { download: true }))
    .toBe('/api/attachments/asset%2F1/content?context_type=card&context_id=card%2F1&download=true');
  expect(attachmentContentUrl('asset/1', { type: 'owner' }))
    .toBe('/api/attachments/asset%2F1/content');
});

test('HTML 문서는 MIME과 확장자 양쪽으로 판별한다', () => {
  expect(isHtmlAttachmentView({ mimeType: 'text/html', name: '문서' })).toBe(true);
  expect(isHtmlAttachmentView({ mimeType: 'text/html; charset=utf-8', name: '문서' })).toBe(true);
  expect(isHtmlAttachmentView({ mimeType: null, name: '보고서.HTML' })).toBe(true);
  expect(isHtmlAttachmentView({ mimeType: 'application/octet-stream', name: '메모.htm' })).toBe(true);
  expect(isHtmlAttachmentView({ mimeType: 'text/plain', name: '메모.txt' })).toBe(false);
  expect(isHtmlAttachmentView({ mimeType: 'application/octet-stream', name: '자료.bin' })).toBe(false);
  expect(isHtmlAttachmentView({ mimeType: null, name: 'html' })).toBe(false);
});

test('Markdown 문서는 정규화한 MIME이나 md·markdown 확장자로 판별한다', () => {
  expect(isMarkdownAttachmentView({ mimeType: 'text/markdown', name: 'memo.txt' })).toBe(true);
  expect(isMarkdownAttachmentView({ mimeType: ' TEXT/MARKDOWN ; charset=utf-8 ', name: 'memo.txt' })).toBe(true);
  expect(isMarkdownAttachmentView({ mimeType: 'application/octet-stream', name: 'proposal.MD' })).toBe(true);
  expect(isMarkdownAttachmentView({ mimeType: null, name: 'proposal.markdown' })).toBe(true);
  expect(isMarkdownAttachmentView({ mimeType: 'text/plain', name: 'memo.txt' })).toBe(false);
  expect(isMarkdownAttachmentView({ mimeType: 'text/plain', name: 'markdown' })).toBe(false);
});

test('레거시 이미지 확장자 판정은 서버의 새 이미지 집합과 같다', () => {
  for (const name of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.avif', 'a.svg', 'a.HEIC', 'a.heif']) {
    expect(isLegacyAttachmentImage(name)).toBe(true);
  }
  for (const name of ['a.pdf', 'a.zip', 'a.txt', 'a.md', 'a.bin', 'svg']) {
    expect(isLegacyAttachmentImage(name)).toBe(false);
  }
});

test('PDF는 MIME과 확장자 양쪽으로 판별한다', () => {
  expect(isPdfAttachmentView({ mimeType: 'application/pdf', name: 'doc.bin' })).toBe(true);
  expect(isPdfAttachmentView({ mimeType: ' Application/PDF ; charset=binary ', name: 'doc' })).toBe(true);
  expect(isPdfAttachmentView({ mimeType: null, name: '보고서.PDF' })).toBe(true);
  expect(isPdfAttachmentView({ mimeType: 'image/png', name: 'doc.pdf' })).toBe(true);
  expect(isPdfAttachmentView({ mimeType: 'application/zip', name: '자료.zip' })).toBe(false);
  expect(isPdfAttachmentView({ mimeType: null, name: 'pdf' })).toBe(false);
});

test('SVG는 MIME, 파일 이름, 레거시 URL의 path로 판별한다', () => {
  expect(isSvgImageMimeType('image/svg+xml')).toBe(true);
  expect(isSvgImageMimeType(' IMAGE/SVG+XML ; charset=utf-8 ')).toBe(true);
  expect(isSvgImageMimeType('image/png')).toBe(false);
  expect(isSvgImageName('도형.SVG')).toBe(true);
  expect(isSvgImageName('svg')).toBe(false);
  expect(isSvgImageUri('/api/attachments/files?nodeId=n1&path=icons%2Flogo.svg')).toBe(true);
  expect(isSvgImageUri('https://example.test/api/attachments/asset%2F1/content')).toBe(false);
  expect(isSvgImageUri('')).toBe(false);
  expect(isSvgAttachmentImage({ mimeType: 'image/svg+xml', name: 'logo' })).toBe(true);
  expect(isSvgAttachmentImage({ mimeType: null, name: 'logo.svg' })).toBe(true);
  expect(isSvgAttachmentImage({ mimeType: null, name: 'logo.png' }, '/files?path=logo.svg')).toBe(true);
  expect(isSvgAttachmentImage({ mimeType: 'image/png', name: 'logo.png' }, '/api/attachments/a/content')).toBe(false);
});
