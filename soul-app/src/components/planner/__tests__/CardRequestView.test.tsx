import { act, fireEvent, render, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';
import { CardRequestView } from '../CardRequestView';
import { AttachmentSvg } from '../../AttachmentSvg';
import { AttachmentReadContextProvider } from '../../../navigation/ContentLinkContexts';
import { ContentLinkProvider } from '../../../navigation/ContentLinkProvider';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
// The shared viewer reads attachment details lazily; keep that read pending so the test sees only the opening.
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn(() => ({ getAttachmentMetadata: jest.fn(() => new Promise(() => {})) })) }));

test('구조화 첨부는 실제 노드 경로를 인증된 기존 이미지 뷰어로 연다', () => {
  const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
  useSettingsStore.setState({ serverUrl: 'https://app.test' });
  useAuthStore.setState({ jwt: 'fixture-token' });
  const screen = render(<ContentLinkProvider><CardRequestView request="긴 원문" attachments={[
    { nodeId: 'node-b', path: '/tmp/picture', name: '사진', mimeType: 'image/png' },
    { nodeId: 'node-b', path: '/tmp/file', name: '문서', mimeType: 'application/pdf' },
  ]} /></ContentLinkProvider>);
  expect(screen.getByTestId('card-request-image-0').props.source).toEqual({
    uri: 'https://app.test/api/attachments/files?nodeId=node-b&path=%2Ftmp%2Fpicture', headers: { Authorization: 'Bearer fixture-token' },
  });
  fireEvent.press(screen.getByLabelText('문서'));
  expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy();
  expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
  screen.unmount();
  fetchSpy.mockRestore();
});

test('요청 원문은 그대로, 이미지 첨부는 그림으로, 문서는 링크로 렌더한다', () => {
  useSettingsStore.setState({ serverUrl: 'https://app.test' });
  useAuthStore.setState({ jwt: 'fixture-token' });
  const image = 'https://app.test/api/attachments/files?nodeId=n&path=%2Ftmp%2Fphoto.png';
  const pdf = 'https://files.test/document.pdf';
  const screen = render(<CardRequestView request={`  원문 그대로  \n\n첨부: 사진(${image})\n첨부: 문서(${pdf})`} />);
  expect(screen.UNSAFE_getByType(EnrichedMarkdownText).props.markdown).toContain('원문 그대로');
  expect(screen.getByTestId('card-request-image-0').props.source).toEqual({ uri: image, headers: { Authorization: 'Bearer fixture-token' } });
  fireEvent.press(screen.getByLabelText('문서'));
  expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(pdf);
  screen.rerender(<CardRequestView request="첨부: 외부(https://other.test/photo.png)" />);
  expect(screen.getByTestId('card-request-image-0').props.source.headers).toBeUndefined();
  act(() => { useAuthStore.setState({ jwt: null }); });
});

test('표시 전용 옵션은 빈 문단만 접고 썸네일을 유지하며, 내부 첨부는 공통 보기 창을, 외부 이미지는 확대를 연다', () => {
  useSettingsStore.setState({ serverUrl: 'https://app.test' });
  const image = 'https://app.test/api/attachments/files?nodeId=n&path=%2Ftmp%2Fphoto.png';
  const request = `첫 문단\n\n\n둘째 문단\n\n![사진](${image})`;
  const defaults = render(<CardRequestView request={request} />);
  expect(defaults.UNSAFE_getByType(EnrichedMarkdownText).props.markdown).toContain(`첫 문단\n\n\n둘째 문단`);
  expect(StyleSheet.flatten(defaults.getByTestId('card-request-image-0').props.style)).toMatchObject({ width: 200, height: 200 });
  expect(defaults.getByTestId('card-request-image-0').props.contentFit).toBe('cover');
  defaults.unmount();

  const summary = render(<ContentLinkProvider><AttachmentReadContextProvider context={{ type: 'card', id: 'card-1' }}>
    <CardRequestView request={request} collapseBlankLines attachmentImageVariant="cardCheckItem" />
  </AttachmentReadContextProvider></ContentLinkProvider>);
  expect(summary.UNSAFE_getByType(EnrichedMarkdownText).props.markdown).toContain('첫 문단\n둘째 문단');
  expect(StyleSheet.flatten(summary.getByTestId('card-request-image-0').props.style)).toMatchObject({ width: 104, height: 60 });
  expect(summary.getByTestId('card-request-image-0').props.contentFit).toBe('cover');
  fireEvent.press(summary.getByTestId('card-request-image-0'));
  expect(summary.getByTestId('attachment-preview-modal')).toBeTruthy();
  summary.unmount();

  const external = 'https://other.test/photo.png';
  const outside = render(<CardRequestView request={`첨부: 외부(${external})`} attachmentImageVariant="cardCheckItem" />);
  fireEvent.press(outside.getByTestId('card-request-image-0'));
  expect(within(outside.getByTestId('image-viewer-pages')).UNSAFE_getByType(Image).props.source.uri).toBe(external);
});

test('서술자 URL이어도 image/svg+xml 첨부는 타일과 보기 창을 react-native-svg로 그린다', () => {
  // No server URL: the tile opens its own viewer instead of routing the internal link
  // through content navigation, which is the same AttachmentImage viewer path.
  useSettingsStore.setState({ serverUrl: '' });
  useAuthStore.setState({ jwt: 'fixture-token' });
  // The SVG read stays pending: the assertion is which renderer the attachment picks, not the drawing.
  const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => new Promise(() => {}));
  const screen = render(<CardRequestView request="원문" attachments={[
    { nodeId: 'node-b', path: '/tmp/picture', name: '그림', mimeType: 'image/svg+xml' },
  ]} />);
  const svg = screen.UNSAFE_getByType(AttachmentSvg);
  expect(svg.props.source.uri).toBe('/api/attachments/files?nodeId=node-b&path=%2Ftmp%2Fpicture');
  expect(svg.props.source.uri).not.toContain('.svg');
  expect(screen.UNSAFE_queryByType(Image)).toBeNull();
  fireEvent.press(screen.getByTestId('card-request-image-0'));
  const pages = screen.getByTestId('image-viewer-pages');
  expect(within(pages).UNSAFE_queryAllByType(AttachmentSvg)).toHaveLength(1);
  expect(within(pages).UNSAFE_queryAllByType(Image)).toHaveLength(0);
  screen.unmount();
  fetchSpy.mockRestore();
  act(() => { useAuthStore.setState({ jwt: null }); });
  useSettingsStore.setState({ serverUrl: 'https://app.test' });
});

test('첨부가 없는 펼친 커멘트의 코드 블록을 복사할 수 있다', () => {
  const screen = render(<CardRequestView request={'명령\n\n```bash\necho hello\n```'} />);
  expect(screen.getByLabelText('코드 복사')).toBeTruthy();
});
