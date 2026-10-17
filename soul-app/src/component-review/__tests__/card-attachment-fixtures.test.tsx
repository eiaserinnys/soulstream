import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { AttachmentView } from '../../lib/attachment-view';
import { AttachmentPreviewModal } from '../../components/AttachmentPreviewModal';
import { PlannerMarkdownText } from '../../components/planner/PlannerMarkdownText';
import { ContentLinkProvider } from '../../navigation/ContentLinkProvider';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { ReviewCardImages } from '../ReviewCardImages';
import { createApiClient, createAttachmentReviewApi } from '../fixture-client';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('../../lib/attachment-image-size', () => ({ getAttachmentImageSize: jest.fn(() => new Promise(() => {})) }));
jest.mock('../../lib/attachment-focus', () => ({ restoreAttachmentFocus: jest.fn() }));

beforeEach(() => {
  useAuthStore.setState({ jwt: 'review-fixture-token' });
  useSettingsStore.setState({ serverUrl: 'https://review.test' });
});

afterEach(() => {
  useAuthStore.setState({ jwt: null });
  useSettingsStore.setState({ serverUrl: '' });
});

test('첨부 검수 fixture는 메타데이터 응답과 HTTP 실패 상태를 보존한다', async () => {
  const api = createAttachmentReviewApi();
  const readContext = { type: 'card' as const, id: 'review-card-attachments' };

  await expect(api.getAttachmentMetadata('review-card-report', readContext)).resolves.toEqual({
    descriptor: {
      attachment_id: 'review-card-report',
      name: '보고 설명.txt',
      mime_type: 'text/plain',
      byte_size: 37,
      checksum_sha256: null,
      width: null,
      height: null,
      preview_kind: 'text',
      preview_mime_type: 'text/plain',
    },
    upload_status: 'committed',
  });

  for (const [attachmentId, status] of [
    ['review-attachment-denied', 403],
    ['review-card-missing', 404],
    ['review-attachment-retryable', 503],
  ] as const) {
    await expect(api.getAttachmentMetadata(attachmentId, readContext))
      .rejects.toMatchObject({ name: 'ApiHttpError', status });
  }
});

test('카드 첨부 표본은 C-10 증거와 보고 본문 내부 링크를 따로 보여준다', () => {
  const screen = render(<ContentLinkProvider>
    <ReviewCardImages serverUrl="https://review.test" />
  </ContentLinkProvider>);

  expect(screen.getByTestId('card-evidence-fixture')).toBeTruthy();
  expect(screen.getByTestId('card-body-attachment-fixture')).toBeTruthy();
  expect(screen.getAllByLabelText('카드 화면.png').length).toBe(3);
  expect(screen.getAllByText('카드 설명.txt').length).toBeGreaterThan(0);
  expect(screen.getAllByText('찾을 수 없음')).toHaveLength(2);
  expect(screen.getByLabelText('legacy-card-image.png')).toBeTruthy();
  expect(screen.getByText('외부 참고 링크')).toBeTruthy();

  expect(screen.getAllByTestId('card-check-item-1-link')[0].props.accessibilityRole).toBe('link');
  fireEvent.press(screen.getByTestId('card-check-item-1-evidence-0'));
  const evidenceAttachments = screen.UNSAFE_getByType(AttachmentPreviewModal).props.items as AttachmentView[];
  expect(evidenceAttachments.map((item) => item.name)).toEqual([
    '카드 화면.png', '카드 두번째 화면.png', '없는 파일.png', 'legacy-card-image.png',
    '카드 설명.txt', '권한 없는 파일.txt', '다시 읽을 파일.txt',
  ]);
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('1 / 7');
  fireEvent.press(screen.getByTestId('chat-image-viewer-next'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 7');
  fireEvent.press(screen.getByTestId('chat-image-viewer-close'));
  expect(screen.getByTestId('card-check-item-1')).toBeTruthy();

  fireEvent.press(screen.getByTestId('card-fold-report-card-attachment-report'));
  const reportMarkdown = screen.UNSAFE_getAllByType(PlannerMarkdownText).map(node => node.props.markdown).join('\n');
  expect(reportMarkdown).toContain('/api/attachments/review-card-report/content?context_type=card&context_id=review-card-attachments');

  fireEvent.press(screen.getByLabelText('새 카드 작성 표본 열기'));
  expect(screen.getByTestId('card-create-header')).toBeTruthy();
});

test('카드 표본 진입점도 실제 모양의 첨부 검수 API를 선택한다', async () => {
  const originalLocation = window.location;
  Object.defineProperty(window, 'location', { configurable: true, value: { search: '?section=cardImages' } });
  try {
    await expect(createApiClient().getAttachmentMetadata('review-card-report', { type: 'owner' }))
      .resolves.toMatchObject({ upload_status: 'committed', descriptor: { attachment_id: 'review-card-report' } });
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  }
});
