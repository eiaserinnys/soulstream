import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { AttachmentReadError } from '../../api/attachmentEndpoints';
import type { AttachmentView } from '../../lib/attachment-view';
import { LIGHT_COLORS } from '../../theme/colors';
import { useTokens } from '../../theme';
import { useSettingsStore } from '../../store/settingsStore';
import { DuoSideBandContext, DuoTopBandContext } from '../../navigation/tabContract';
import { PlannerMarkdownText } from '../planner/PlannerMarkdownText';
import { AttachmentPreviewModal } from '../AttachmentPreviewModal';

const mockReadAttachmentText = jest.fn();
const mockReadAttachmentMedia = jest.fn();
jest.mock('../../api/client', () => ({
  createApiClient: () => ({
    readAttachmentText: (...args: unknown[]) => mockReadAttachmentText(...args),
    readAttachmentMedia: (...args: unknown[]) => mockReadAttachmentMedia(...args),
  }),
}));
// PDF 미리보기는 캐시 파일로 내려받은 뒤 WebView에 file URI를 넘긴다.
jest.mock('expo-file-system', () => {
  class Directory {
    exists = true;

    create() {}
  }
  const deleted: string[] = [];
  class File {
    uri: string;
    existing: boolean;

    constructor(_parent: unknown, name: string) {
      this.existing = !name;
      this.uri = name ? `file:///mock/cache/attachment-pdf/${name}` : String(_parent);
    }

    get exists() {
      return this.existing;
    }

    delete() { deleted.push(this.uri); }

    static readonly downloadFileAsync = jest.fn(async (_url: string, destination: { uri: string }) => ({
      uri: destination.uri,
    }));
  }
  return { Directory, File, deleted, Paths: { cache: { uri: 'file:///mock/cache' } } };
});
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
  mockReadAttachmentMedia.mockReset();
  mockReadAttachmentMedia.mockResolvedValue({ uri: 'data:video/mp4;base64,AAAA', mimeType: 'video/mp4' });
  const { File } = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
  File.downloadFileAsync.mockClear();
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
});

afterEach(() => {
  jest.restoreAllMocks();
  useSettingsStore.setState({ serverUrl: '' });
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
  const renderedMarkdown = screen.getAllByTestId('planner-markdown-rendered').map(node => node.props.markdown);
  expect(renderedMarkdown.some(part => part.includes('# Argon 톤 제안'))).toBe(true);
  expect(renderedMarkdown.some(part => part.startsWith('```ts'))).toBe(true);
  expect(renderedMarkdown.some(part => part.includes('[원문](https://example.com/argon-tone)'))).toBe(true);
  expect(screen.getByTestId('codeblock-copy-button-0')).toBeTruthy();
  expect(screen.queryByTestId('attachment-preview-text')).toBeNull();
  const preview = screen.getByTestId('attachment-preview-markdown');
  expect(StyleSheet.flatten(preview.props.style).flex).toBe(1);
  const frame = screen.getByTestId('chat-image-viewer-frame');
  expect(StyleSheet.flatten(frame.props.style).flex).toBe(1);
  expect(StyleSheet.flatten(frame.props.style).height).toBeUndefined();
  expect(StyleSheet.flatten(preview.parent!.props.style)).not.toHaveProperty('justifyContent');
  expect(mockReadAttachmentText).toHaveBeenCalledWith('attachment-1', { type: 'card', id: 'card-1' }, expect.any(AbortSignal));
});

test('keeps a loaded Markdown preview for the same attachment and reads a different attachment', async () => {
  mockReadAttachmentText.mockResolvedValue({ text: '# 읽던 문서', truncated: false });
  const makeMarkdown = (key: string) => makeView({ key, name: '문서.md', mimeType: 'text/markdown' });
  const screen = render(<AttachmentPreviewModal item={makeMarkdown('attachment-1')} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('attachment-preview-markdown')).toBeTruthy());

  screen.rerender(<AttachmentPreviewModal item={makeMarkdown('attachment-1')} onClose={jest.fn()} />);
  expect(screen.queryByTestId('attachment-preview-loading')).toBeNull();
  expect(screen.getByTestId('attachment-preview-markdown')).toBeTruthy();
  expect(mockReadAttachmentText).toHaveBeenCalledTimes(1);

  screen.rerender(<AttachmentPreviewModal item={makeMarkdown('attachment-2')} onClose={jest.fn()} />);
  await waitFor(() => expect(mockReadAttachmentText).toHaveBeenCalledTimes(2));
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

test('saving stays busy until settlement and rejection is shown without HTTP codes', async () => {
  let reject!: (error: Error) => void;
  const save = jest.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
  const screen = render(<AttachmentPreviewModal item={makeView({ previewKind: 'info' })} onClose={jest.fn()} onSaveOriginal={save} />);
  fireEvent.press(screen.getByLabelText('원본 저장'));
  expect(screen.getByLabelText('원본 저장').props.accessibilityState.busy).toBe(true);
  expect(screen.getByLabelText('원본 저장').props.disabled).toBeFalsy();
  fireEvent.press(screen.getByLabelText('원본 저장'));
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('저장 실패 (403)')));
  expect(screen.getByText('저장 실패')).toBeTruthy();
  expect(screen.getByLabelText('원본 저장').props.accessibilityState.busy).toBeFalsy();
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
  expect(screen.getByTestId('attachment-preview-html').props.source.html)
    .toContain('<style>:where(:root){color-scheme:light;}</style>');
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
  expect(screen.getByTestId('attachment-preview-html').props.style.backgroundColor)
    .toBe(LIGHT_COLORS.background);
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

test.each([
  ['데모 녹화.mp4', 'application/octet-stream', 'video', 'video/mp4'],
  ['배경음.mp3', 'audio/mpeg', 'audio', 'audio/mpeg'],
  ['효과음.wav', 'audio/wav', 'audio', 'audio/wav'],
  ['원음.flac', 'audio/flac', 'audio', 'audio/flac'],
] as const)('%s는 첨부 MIME과 관계없이 미디어 플레이어를 연다', async (name, mimeType, mediaKind, expectedMimeType) => {
  const item = makeView({
    key: name,
    name,
    mimeType,
    byteSize: 64,
    previewKind: 'info',
  });
  mockReadAttachmentMedia.mockResolvedValueOnce({
    uri: `data:${expectedMimeType};base64,AAAA`,
    mimeType: expectedMimeType,
  });
  const screen = render(<AttachmentPreviewModal item={item} onClose={jest.fn()} />);

  const player = await waitFor(() => screen.getByTestId(mediaKind === 'video'
    ? 'attachment-preview-video' : 'attachment-preview-audio'));
  expect(mockReadAttachmentMedia).toHaveBeenCalledWith(
    item.source.kind === 'ready' ? item.source.attachmentId : '',
    item.readContext,
    expect.any(AbortSignal),
    { mimeType, name },
  );
  expect(player.props.source.html).toContain(`<${mediaKind} controls`);
  expect(player.props.source.html).toContain(`type="${expectedMimeType}"`);
  expect(player.props.source.html).toContain(`src="data:${expectedMimeType};base64,AAAA"`);
});

test.each([
  ['empty-video.mp4', 'video/mp4', 'video'],
  ['empty-audio.mp3', 'audio/mpeg', 'audio'],
] as const)('%s is shown as an empty file without a media request', (name, mimeType, mediaKind) => {
  const screen = render(<AttachmentPreviewModal item={makeView({
    name,
    mimeType,
    previewKind: 'info',
    byteSize: 0,
  })} onClose={jest.fn()} />);

  expect(screen.getByText('빈 파일')).toBeTruthy();
  expect(screen.queryByTestId(mediaKind === 'video' ? 'attachment-preview-video' : 'attachment-preview-audio')).toBeNull();
  expect(mockReadAttachmentMedia).not.toHaveBeenCalled();
});

test('일반 태블릿의 문서 미리보기는 프레임 높이에 맞춘 A4 폭 제한을 유지한다', async () => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({
    width: 1180, height: 820, scale: 1, fontScale: 1,
  });
  const t = renderHook(() => useTokens()).result.current;
  mockReadAttachmentText.mockResolvedValue({ text: '# 문서', truncated: false });
  const screen = render(<AttachmentPreviewModal item={makeView({ name: '보고.md', mimeType: 'text/markdown' })}
    onClose={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('attachment-preview-markdown')).toBeTruthy());
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-surface').props.style).width).toBe('100%');
  fireEvent(screen.getByTestId('chat-image-viewer-frame'), 'layout', { nativeEvent: { layout: { height: 500 } } });
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-surface').props.style).width)
    .toBe(Math.round(500 * Math.SQRT2) + t.spacing.md * 2);
});

test.each([
  ['DuoSideBandContext', DuoSideBandContext],
  ['DuoTopBandContext', DuoTopBandContext],
] as const)('듀오 펼침(%s)에서는 문서 미리보기가 A4 제한 없이 전체 폭을 쓴다', async (_name, Context) => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({
    width: 951, height: 669, scale: 1, fontScale: 1,
  });
  mockReadAttachmentText.mockResolvedValue({ text: '# 문서', truncated: false });
  const screen = render(
    <Context.Provider value={true}>
      <AttachmentPreviewModal item={makeView({ name: '보고.md', mimeType: 'text/markdown' })} onClose={jest.fn()} />
    </Context.Provider>,
  );

  await waitFor(() => expect(screen.getByTestId('attachment-preview-markdown')).toBeTruthy());
  fireEvent(screen.getByTestId('chat-image-viewer-frame'), 'layout', { nativeEvent: { layout: { height: 500 } } });
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-surface').props.style).width).toBe('100%');
});

test('plain text keeps a fixed-width font and stays selectable', async () => {
  const screen = render(<AttachmentPreviewModal item={makeView()} onClose={jest.fn()} />);
  const text = await waitFor(() => screen.getByText('<b>plain text</b> **not markdown**'));
  const style = StyleSheet.flatten(text.props.style);
  expect(style.fontFamily).toBe(Platform.OS === 'ios' ? 'Menlo' : 'monospace');
  expect(style.fontSize).toBe(useTokensFontSize());
  expect(text.props.selectable).toBe(true);
});

function useTokensFontSize(): number {
  return renderHook(() => useTokens()).result.current.foundation.typography.mono.fontSize;
}

const pdfView = (overrides: Partial<AttachmentView> = {}): AttachmentView => makeView({
  key: 'pdf-1',
  name: '제안서.pdf',
  mimeType: 'application/pdf',
  byteSize: 4096,
  previewKind: 'info',
  ...overrides,
});

test('PDF는 문서 레이아웃에서 내려받은 파일을 WebView로 열고 저장을 남긴다', async () => {
  const screen = render(<AttachmentPreviewModal item={pdfView()} onClose={jest.fn()} onSaveOriginal={jest.fn()} />);
  const preview = await waitFor(() => screen.getByTestId('attachment-preview-pdf'));

  expect(preview.props.source.uri).toMatch(/^file:\/\/\/mock\/cache\/attachment-pdf\/.+\.pdf$/);
  expect(preview.props.javaScriptEnabled).toBe(false);
  // 문서 미리보기: 미디어 프레임 높이 대신 가용 높이를 쓴다.
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-frame').props.style).flex).toBe(1);
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-viewer-frame').props.style).height).toBeUndefined();
  expect(screen.getByLabelText('원본 저장')).toBeTruthy();
  expect(mockReadAttachmentText).not.toHaveBeenCalled();
});

test('안드로이드는 PDF를 지금처럼 아이콘과 저장으로 둔다', async () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'android');
  try {
    const screen = render(<AttachmentPreviewModal item={pdfView()} onClose={jest.fn()} onSaveOriginal={jest.fn()} />);
    expect(screen.getByLabelText('PDF 파일')).toBeTruthy();
    expect(screen.queryByTestId('attachment-preview-pdf')).toBeNull();
    expect(screen.getByLabelText('원본 저장')).toBeTruthy();
    const { File } = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
    expect(File.downloadFileAsync).not.toHaveBeenCalled();
  } finally {
    platform.restore();
  }
});

test('빈 PDF는 빈 파일로 표시하고 내려받지 않는다', () => {
  const screen = render(<AttachmentPreviewModal item={pdfView({ byteSize: 0 })} onClose={jest.fn()} />);
  expect(screen.getByText('빈 파일')).toBeTruthy();
  expect(screen.queryByTestId('attachment-preview-pdf')).toBeNull();
  const { File } = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
  expect(File.downloadFileAsync).not.toHaveBeenCalled();
});

test('PDF를 내려받지 못하면 다시 시도할 수 있다', async () => {
  const { File } = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
  File.downloadFileAsync.mockRejectedValueOnce(new Error('download failed (status 503)'));
  const screen = render(<AttachmentPreviewModal item={pdfView()} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('미리보기를 불러오지 못했습니다.')).toBeTruthy());
  expect(File.downloadFileAsync).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(screen.getByTestId('attachment-preview-pdf')).toBeTruthy());
  expect(File.downloadFileAsync).toHaveBeenCalledTimes(2);
});

test('media 403 failures have no retry and 503 failures can be retried', async () => {
  mockReadAttachmentMedia.mockRejectedValueOnce(new AttachmentReadError('denied', 403));
  const denied = render(<AttachmentPreviewModal item={makeView({
    name: 'denied.mp4', mimeType: 'video/mp4', previewKind: 'info',
  })} onClose={jest.fn()} />);
  await waitFor(() => expect(denied.getByText('접근 권한이 없습니다.')).toBeTruthy());
  expect(denied.queryByText('다시 시도')).toBeNull();

  mockReadAttachmentMedia.mockRejectedValueOnce(new AttachmentReadError('retryable', 503));
  const retryable = render(<AttachmentPreviewModal item={makeView({
    key: 'retryable-media', name: 'retryable.mp3', mimeType: 'audio/mpeg', previewKind: 'info',
  })} onClose={jest.fn()} />);
  await waitFor(() => expect(retryable.getByText('미리보기를 불러오지 못했습니다.')).toBeTruthy());
  mockReadAttachmentMedia.mockResolvedValueOnce({ uri: 'data:audio/mpeg;base64,AAAA', mimeType: 'audio/mpeg' });
  fireEvent.press(retryable.getByText('다시 시도'));
  await waitFor(() => expect(mockReadAttachmentMedia).toHaveBeenCalledTimes(3));
  expect(retryable.getByTestId('attachment-preview-audio')).toBeTruthy();
});

 test('세션 파일 PDF는 임시 파일을 닫을 때 삭제한다', async () => {
  const fs = require('expo-file-system') as { deleted: string[] };
  fs.deleted.length = 0;
  const screen = render(<AttachmentPreviewModal item={pdfView({ pdfCache: 'none' })} onClose={jest.fn()} />);
  const preview = await waitFor(() => screen.getByTestId('attachment-preview-pdf'));
  const uri = preview.props.source.uri;
  screen.unmount();
  expect(fs.deleted).toContain(uri);
});


test.each(['복제', '추가'])('세션 PDF 목록 %s 시 열린 파일을 유지한다', async (change) => {
  const { SessionFilesView } = require('../../screens/SessionFilesScreen');
  const { reviewWorkspace } = require('../../component-review/ReviewSessionFiles');
  const fs = require('expo-file-system') as { deleted: string[]; File: { downloadFileAsync: jest.Mock } };
  fs.deleted.length = 0;
  const file = { ...reviewWorkspace.files[0], path: 'document.pdf', size: 100 };
  const data = { ...reviewWorkspace, files: [file], read_only: [] };
  const props = { data, error: false, refreshing: false, onRefresh: jest.fn(), expanded: false, onToggle: jest.fn(), selected: file.path, onSelect: jest.fn(), sessionId: 'session' };
  const screen = render(<SessionFilesView {...props} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(1));
  const files = change === '복제' ? [{ ...file }] : [{ ...file }, { ...file, path: 'other.pdf' }];
  screen.rerender(<SessionFilesView {...props} data={{ ...data, files }} />);
  await act(async () => { await Promise.resolve(); });
  expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(1);
  expect(fs.deleted).toHaveLength(0);
  screen.rerender(<SessionFilesView {...props} data={{ ...data, files: [{ ...file, size: 101 }] }} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(2));
  expect(fs.deleted).toHaveLength(1);
});

test('두 번째 PDF를 본 뒤 앞에 파일이 추가되어도 현재 파일을 유지한다', async () => {
  const fs = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
  const source = (id: string) => ({ kind: 'ready' as const, attachmentId: id, previewUrl: null, originalUrl: "/" + id + ".pdf" });
  const first = pdfView({ key: 'first', name: 'first.pdf', source: source('first') });
  const second = pdfView({ key: 'second', name: 'second.pdf', source: source('second') });
  const added = pdfView({ key: 'added', name: 'added.pdf', source: source('added') });
  const screen = render(<AttachmentPreviewModal item={first} items={[first, second]} onClose={jest.fn()} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByLabelText('다음 첨부'));
  await waitFor(() => expect(screen.getByText('second.pdf')).toBeTruthy());
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(2));
  const uri = screen.getByTestId('attachment-preview-pdf').props.source.uri;
  const offset = screen.getByTestId('image-viewer-pages').props.contentOffset.x;
  expect(offset).toBeGreaterThan(0);
  screen.rerender(<AttachmentPreviewModal item={first} items={[added, first, second]} onClose={jest.fn()} />);
  expect(screen.getByText('second.pdf')).toBeTruthy();
  expect(screen.getByTestId('attachment-preview-pdf').props.source.uri).toBe(uri);
  expect(screen.getByTestId('image-viewer-pages').props.contentOffset.x).toBe(offset * 2);
  expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(2);
});

test('새 스냅샷의 같은 크기 세션 PDF를 다시 받는다', async () => {
  const { SessionFilesView } = require('../../screens/SessionFilesScreen');
  const { reviewWorkspace } = require('../../component-review/ReviewSessionFiles');
  const fs = require('expo-file-system') as { deleted: string[]; File: { downloadFileAsync: jest.Mock } };
  fs.deleted.length = 0;
  const file = { ...reviewWorkspace.files[0], path: 'document.pdf', size: 100 };
  const data = { ...reviewWorkspace, snapshot: { ...reviewWorkspace.snapshot, observed_at: 'one' }, files: [file], read_only: [] };
  const props = { data, error: false, refreshing: false, onRefresh: jest.fn(), expanded: false, onToggle: jest.fn(), selected: file.path, onSelect: jest.fn(), sessionId: 'session' };
  const screen = render(<SessionFilesView {...props} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(1));
  screen.rerender(<SessionFilesView {...props} data={{ ...data, snapshot: { ...data.snapshot, observed_at: 'two' } }} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(2));
  expect(fs.deleted).toHaveLength(1);
});

test('같은 첨부 ID에서 PDF 원본 주소가 바뀌면 다시 받는다', async () => {
  const fs = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
  const first = pdfView({ pdfCache: 'none', source: { kind: 'ready', attachmentId: 'same', previewUrl: null, originalUrl: '/first.pdf' } });
  const second = { ...first, source: { ...first.source, kind: 'ready' as const, attachmentId: 'same', previewUrl: null, originalUrl: '/second.pdf' } };
  const screen = render(<AttachmentPreviewModal item={first} onClose={jest.fn()} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(1));
  screen.rerender(<AttachmentPreviewModal item={second} onClose={jest.fn()} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(2));
});

test.each(['activity', 'read-only'])('세션 PDF의 %s 변경으로 다시 받는다', async (kind) => {
  const { SessionFilesView } = require('../../screens/SessionFilesScreen');
  const { reviewWorkspace } = require('../../component-review/ReviewSessionFiles');
  const fs = require('expo-file-system') as { File: { downloadFileAsync: jest.Mock } };
  const file = { ...reviewWorkspace.files[0], path: 'document.pdf', size: 100, last_activity_at: 'one' };
  const read = { path: 'document.pdf', size: null, last_read_at: 'one' };
  const data = { ...reviewWorkspace, snapshot: { ...reviewWorkspace.snapshot, observed_at: 'one' }, files: kind === 'activity' ? [file] : [], read_only: kind === 'read-only' ? [read] : [] };
  const props = { data, error: false, refreshing: false, onRefresh: jest.fn(), expanded: true, onToggle: jest.fn(), selected: 'document.pdf', onSelect: jest.fn(), sessionId: 'session' };
  const screen = render(<SessionFilesView {...props} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(1));
  const changed = kind === 'activity' ? { ...data, files: [{ ...file, last_activity_at: 'two' }] } : { ...data, snapshot: { ...data.snapshot, observed_at: 'two' } };
  screen.rerender(<SessionFilesView {...props} data={changed} />);
  await waitFor(() => expect(fs.File.downloadFileAsync).toHaveBeenCalledTimes(2));
});
