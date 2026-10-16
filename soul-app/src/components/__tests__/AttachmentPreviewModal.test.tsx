import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { AttachmentReadError } from '../../api/attachmentEndpoints';
import type { AttachmentView } from '../../lib/attachment-view';
import { AttachmentPreviewModal } from '../AttachmentPreviewModal';

const mockReadAttachmentText = jest.fn();
jest.mock('../../api/client', () => ({
  createApiClient: () => ({ readAttachmentText: (...args: unknown[]) => mockReadAttachmentText(...args) }),
}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const makeView = (overrides: Partial<AttachmentView> = {}): AttachmentView => ({
  key: 'attachment-1',
  name: 'notes.txt',
  mimeType: 'text/plain',
  byteSize: 1048576,
  previewKind: 'text',
  readContext: { type: 'card', id: 'card-1' },
  source: {
    kind: 'ready',
    attachmentId: 'attachment-1',
    previewUrl: null,
    originalUrl: '/api/attachments/attachment-1/content?download=true',
  },
  ...overrides,
});

beforeEach(() => {
  mockReadAttachmentText.mockReset();
  mockReadAttachmentText.mockResolvedValue({ text: '<b>plain text</b> **not markdown**', truncated: false });
});

test('text preview renders bounded content as plain text and omits MIME from the modal header', async () => {
  const screen = render(<AttachmentPreviewModal item={makeView()} onClose={() => {}} />);

  await waitFor(() => expect(screen.getByText('<b>plain text</b> **not markdown**')).toBeTruthy());
  expect(screen.getByText('notes.txt')).toBeTruthy();
  expect(screen.getByText('1.0 MB')).toBeTruthy();
  expect(screen.queryByText('text/plain')).toBeNull();
  expect(mockReadAttachmentText).toHaveBeenCalledWith('attachment-1', { type: 'card', id: 'card-1' }, expect.any(AbortSignal));
});

test('empty text is represented only by the empty-file state', async () => {
  mockReadAttachmentText.mockResolvedValue({ text: '', truncated: false });
  const screen = render(<AttachmentPreviewModal item={makeView()} onClose={() => {}} />);

  await waitFor(() => expect(screen.getByText('빈 파일')).toBeTruthy());
  expect(screen.queryByText('내용이 없습니다')).toBeNull();
});

test('info files show only their extension mark and unavailable files have no save action', () => {
  const info = render(<AttachmentPreviewModal item={makeView({
    name: 'archive.bin', mimeType: 'application/octet-stream', previewKind: 'info',
  })} onClose={() => {}} onSaveOriginal={jest.fn()} />);
  expect(info.getByText('BIN')).toBeTruthy();
  expect(info.queryByText('application/octet-stream')).toBeNull();

  const missing = render(<AttachmentPreviewModal item={makeView({
    source: { kind: 'unavailable', availability: 'missing' },
  })} onClose={() => {}} onSaveOriginal={jest.fn()} />);
  expect(missing.getByText('찾을 수 없음')).toBeTruthy();
  expect(missing.queryByLabelText('원본 저장')).toBeNull();
});

test('only retryable preview failures offer a retry action', async () => {
  mockReadAttachmentText.mockRejectedValueOnce(new AttachmentReadError('denied', 403));
  const denied = render(<AttachmentPreviewModal item={makeView()} onClose={() => {}} />);
  await waitFor(() => expect(denied.getByText('접근 권한이 없습니다.')).toBeTruthy());
  expect(denied.queryByText('다시 시도')).toBeNull();

  mockReadAttachmentText.mockRejectedValueOnce(new AttachmentReadError('retryable', 503));
  const retryable = render(<AttachmentPreviewModal item={makeView({ key: 'attachment-2' })} onClose={() => {}} />);
  await waitFor(() => expect(retryable.getByText('미리보기를 불러오지 못했습니다.')).toBeTruthy());
  fireEvent.press(retryable.getByText('다시 시도'));
  await waitFor(() => expect(mockReadAttachmentText).toHaveBeenCalledTimes(3));
});
