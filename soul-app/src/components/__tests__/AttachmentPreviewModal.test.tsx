import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet, TouchableOpacity, View } from 'react-native';
import { AttachmentReadError } from '../../api/attachmentEndpoints';
import type { AttachmentView } from '../../lib/attachment-view';
import { PlannerMarkdownText } from '../planner/PlannerMarkdownText';
import { AttachmentPreviewModal } from '../AttachmentPreviewModal';

const mockReadAttachmentText = jest.fn();
jest.mock('../../api/client', () => ({
  createApiClient: () => ({ readAttachmentText: (...args: unknown[]) => mockReadAttachmentText(...args) }),
}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-enriched-markdown', () => ({
  EnrichedMarkdownText: (props: any) => require('react').createElement(
    require('react-native').Text,
    { ...props, testID: 'planner-markdown-rendered' },
    props.markdown,
  ),
}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

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

test('zero-byte text never requests content', () => {
  const screen = render(<AttachmentPreviewModal item={makeView({ byteSize: 0 })} onClose={jest.fn()} />);
  expect(screen.getByText('빈 파일')).toBeTruthy();
  expect(mockReadAttachmentText).not.toHaveBeenCalled();
});

test('empty Markdown shows its empty-file state centered in the frame', () => {
  const screen = render(<AttachmentPreviewModal item={makeView({
    name: 'empty.md', mimeType: 'text/markdown', byteSize: 0,
  })} onClose={jest.fn()} />);

  const message = screen.getByText('빈 파일');
  let content = message.parent;
  while (content && content.type !== View) content = content.parent;
  expect(content).toBeTruthy();
  expect(StyleSheet.flatten(content!.props.style)).toMatchObject({
    alignItems: 'center',
    justifyContent: 'center',
  });
  expect(screen.queryByTestId('attachment-preview-markdown')).toBeNull();
  expect(mockReadAttachmentText).not.toHaveBeenCalled();
});

test('caller-provided local text is shown without a server read', async () => {
  const screen = render(<AttachmentPreviewModal item={makeView()} onClose={() => {}}
    textContent={{ text: 'local preview', truncated: true }} />);

  await waitFor(() => expect(screen.getByText('local preview')).toBeTruthy());
  expect(screen.getByText('앞부분만 표시')).toBeTruthy();
  expect(mockReadAttachmentText).not.toHaveBeenCalled();
});

test('Markdown preview renders through PlannerMarkdownText in the document frame', async () => {
  const markdown = '# Argon 톤 제안\n\n## 방향\n\n- 차분하게\n- 선명하게\n\n| 토큰 | 값 |\n| --- | --- |\n| 강조 | 따뜻함 |\n\n```ts\nconst tone = "warm";\n```\n\n[원문](https://example.com/argon-tone)';
  mockReadAttachmentText.mockResolvedValue({ text: markdown, truncated: false });
  const screen = render(<AttachmentPreviewModal item={makeView({ name: '톤 제안 원문.md', mimeType: 'text/markdown' })}
    onClose={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('attachment-preview-markdown')).toBeTruthy());
  expect(screen.UNSAFE_getByType(PlannerMarkdownText).props).toMatchObject({
    markdown,
    readContext: { type: 'card', id: 'card-1' },
  });
  expect(screen.getByTestId('planner-markdown-rendered').props.markdown).toBe(markdown);
  expect(screen.queryByTestId('attachment-preview-text')).toBeNull();
  const preview = screen.getByTestId('attachment-preview-markdown');
  expect(StyleSheet.flatten(preview.props.style).flex).toBe(1);
  const frame = screen.getByTestId('chat-image-viewer-frame');
  expect(StyleSheet.flatten(frame.props.style).flex).toBe(1);
  expect(StyleSheet.flatten(frame.props.style).height).toBeUndefined();
  expect(StyleSheet.flatten(preview.parent!.props.style)).not.toHaveProperty('justifyContent');
  expect(mockReadAttachmentText).toHaveBeenCalledWith('attachment-1', { type: 'card', id: 'card-1' }, expect.any(AbortSignal));
});

test('caller-provided Markdown uses the renderer and keeps the truncation label', async () => {
  const markdown = '## local preview';
  const screen = render(<AttachmentPreviewModal item={makeView({ name: 'local.md', mimeType: 'text/markdown' })} onClose={jest.fn()}
    textContent={{ text: markdown, truncated: true }} />);

  await waitFor(() => expect(screen.getByTestId('attachment-preview-markdown')).toBeTruthy());
  expect(screen.UNSAFE_getByType(PlannerMarkdownText).props.markdown).toBe(markdown);
  expect(screen.getByText('앞부분만 표시')).toBeTruthy();
  expect(mockReadAttachmentText).not.toHaveBeenCalled();
});

test('long text scrolls inside a fixed frame with the save action outside', async () => {
  mockReadAttachmentText.mockResolvedValue({ text: 'line\n'.repeat(300), truncated: false });
  const screen = render(<AttachmentPreviewModal item={makeView()} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('attachment-preview-text')).toBeTruthy());
  const frame = screen.getByTestId('chat-image-viewer-frame');
  expect(StyleSheet.flatten(frame.props.style).height).toBeGreaterThan(0);
  expect(StyleSheet.flatten(screen.getByTestId('attachment-preview-text').props.style).flex).toBe(1);
  expect(screen.getByLabelText('원본 저장')).toBeTruthy();
});

test('saving is disabled until settlement and rejection is shown without HTTP codes', async () => {
  let reject!: (error: Error) => void;
  const save = jest.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  const screen = render(<AttachmentPreviewModal item={makeView({ previewKind: 'info' })} onClose={jest.fn()} onSaveOriginal={save} />);
  fireEvent.press(screen.getByLabelText('원본 저장'));
  expect(screen.getByLabelText('원본 저장').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByLabelText('원본 저장'));
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('저장 실패 (403)')));
  expect(screen.getByText('저장 실패')).toBeTruthy();
  expect(screen.getByLabelText('원본 저장').props.accessibilityState.disabled).toBe(false);
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


test('navigation endpoints stay focusable, dimmed, and named for any attachment type', () => {
  const items = [makeView({ previewKind: 'info' }), makeView({ key: 'two', previewKind: 'info' })];
  const screen = render(<AttachmentPreviewModal item={items[0]} items={items} onClose={jest.fn()} />);
  const previous = screen.getByLabelText('이전 첨부');
  expect(previous.props.disabled).not.toBe(true);
  expect(previous.props.accessibilityState.disabled).toBe(true);
  expect(StyleSheet.flatten(previous.props.style).opacity).toBe(0.55);
  expect(StyleSheet.flatten(screen.getByLabelText('다음 첨부').props.style).opacity).not.toBe(0.55);
  fireEvent.press(screen.getByLabelText('다음 첨부'));
  // Jest does not advance RN's native opacity animation; check the supplied RN control style.
  const nextControl = screen.UNSAFE_getAllByType(TouchableOpacity).find(control => control.props.testID === 'chat-image-viewer-next')!;
  expect(StyleSheet.flatten(nextControl.props.style).opacity).toBe(0.55);
  fireEvent.press(screen.getByLabelText('다음 첨부'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 2');
});

test('unavailable items retain the original-save layout slot while hiding its action', () => {
  const items = [makeView({ previewKind: 'info' }), makeView({ key: 'missing', source: { kind: 'unavailable', availability: 'missing' } })];
  const screen = render(<AttachmentPreviewModal item={items[0]} items={items} onClose={jest.fn()} />);
  expect(screen.getByTestId('attachment-viewer-save-slot')).toBeTruthy();
  fireEvent.press(screen.getByTestId('chat-image-viewer-next'));
  expect(screen.queryByLabelText('원본 저장')).toBeNull();
  const slot = screen.getByTestId('attachment-viewer-save-slot', { includeHiddenElements: true });
  expect(slot.props.children).toBeTruthy();
  expect(StyleSheet.flatten(slot.props.style).opacity).toBe(0);
  expect(StyleSheet.flatten(slot.props.style).display).not.toBe('none');
});

test('an HTML attachment marked informational still opens as a rendered document', async () => {
  mockReadAttachmentText.mockResolvedValue({ text: '<h1>문서 본문</h1>', truncated: false });
  const screen = render(<AttachmentPreviewModal item={makeView({
    name: '제안서.html', mimeType: 'text/html', previewKind: 'info', byteSize: 10_401,
  })} onClose={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('attachment-preview-html')).toBeTruthy());
  expect(mockReadAttachmentText).toHaveBeenCalledWith('attachment-1', { type: 'card', id: 'card-1' }, expect.any(AbortSignal));
  expect(screen.getByTestId('attachment-preview-html').props.accessibilityLabel).toContain('문서 본문');
  // The document layout gives the frame the available height instead of a media frame.
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-frame').props.style).flex).toBe(1);
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-frame').props.style).height).toBeUndefined();
});

test('a metadata-pending Markdown name opens a single-item bundle in the document frame', () => {
  const item = makeView({
    key: 'report-md',
    name: '보고 설명.md',
    mimeType: null,
    byteSize: null,
    previewKind: 'info',
    loadMetadata: jest.fn(() => new Promise<AttachmentView>(() => {})),
  });
  const screen = render(<AttachmentPreviewModal item={item} items={[item]} onClose={jest.fn()} />);

  expect(screen.getByTestId('attachment-metadata-loading')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-frame').props.style).flex).toBe(1);
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-frame').props.style).height).toBeUndefined();
  expect(screen.queryByTestId('attachment-preview-markdown')).toBeNull();
});

test('an HTML document reads its body through the injected loader instead of the content API', async () => {
  const loadText = jest.fn().mockResolvedValue({ text: '<p>레거시 문서</p>', truncated: false });
  const screen = render(<AttachmentPreviewModal item={makeView({
    name: 'legacy.html', mimeType: 'text/html', previewKind: 'info', byteSize: 2048, loadText,
  })} onClose={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('attachment-preview-html')).toBeTruthy());
  expect(loadText).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(mockReadAttachmentText).not.toHaveBeenCalled();
});

test('an empty HTML document shows the empty-file state without rendering a web view', async () => {
  const screen = render(<AttachmentPreviewModal item={makeView({
    name: 'empty.html', mimeType: 'text/html', previewKind: 'info', byteSize: 0,
  })} onClose={jest.fn()} />);

  await waitFor(() => expect(screen.getByText('빈 파일')).toBeTruthy());
  expect(screen.queryByTestId('attachment-preview-html')).toBeNull();
  expect(mockReadAttachmentText).not.toHaveBeenCalled();
});

test('a non-HTML attachment keeps the media frame', async () => {
  const screen = render(<AttachmentPreviewModal item={makeView()} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('attachment-preview-text')).toBeTruthy());
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-frame').props.style).height).toBeGreaterThan(0);
});
