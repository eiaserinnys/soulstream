import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Image, StyleSheet } from 'react-native';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { CardRequestView } from '../CardRequestView';
import { AttachmentReadContextProvider, ContentLinkProvider } from '../../../navigation/ContentLinkProvider';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
// The shared viewer reads attachment details lazily; keep that read pending so the test sees only the opening.
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn(() => ({ getAttachmentMetadata: jest.fn(() => new Promise(() => {})) })) }));

test('구조화 첨부는 실제 노드 경로를 인증된 기존 이미지 뷰어로 연다', () => {
  useSettingsStore.setState({ serverUrl: 'https://app.test' });
  useAuthStore.setState({ jwt: 'fixture-token' });
  const screen = render(<CardRequestView request="긴 원문" attachments={[
    { nodeId: 'node-b', path: '/tmp/picture', name: '사진', mimeType: 'image/png' },
    { nodeId: 'node-b', path: '/tmp/file', name: '문서', mimeType: 'application/pdf' },
  ]} />);
  expect(screen.getByTestId('card-request-image-0').props.source).toEqual({
    uri: 'https://app.test/api/attachments/files?nodeId=node-b&path=%2Ftmp%2Fpicture', headers: { Authorization: 'Bearer fixture-token' },
  });
  fireEvent.press(screen.getByLabelText('문서'));
  expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://app.test/api/attachments/files?nodeId=node-b&path=%2Ftmp%2Ffile');
});

test('요청 원문은 그대로, 이미지 첨부는 그림으로, 문서는 링크로 렌더한다', () => {
  useSettingsStore.setState({ serverUrl: 'https://app.test' });
  useAuthStore.setState({ jwt: 'fixture-token' });
  const image = 'https://app.test/api/attachments/files?nodeId=n&path=%2Ftmp%2Fphoto.png';
  const pdf = 'https://files.test/document.pdf';
  const screen = render(<CardRequestView request={`  원문 그대로  \n\n첨부: 사진(${image})\n첨부: 문서(${pdf})`} />);
  expect(screen.getByText('  원문 그대로  ')).toBeTruthy();
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
  expect(defaults.getByText(`첫 문단\n\n\n둘째 문단`).props.children).toBe(`첫 문단\n\n\n둘째 문단`);
  expect(StyleSheet.flatten(defaults.getByTestId('card-request-image-0').props.style)).toMatchObject({ width: 200, height: 200 });
  expect(defaults.getByTestId('card-request-image-0').props.resizeMode).toBe('cover');
  defaults.unmount();

  const summary = render(<ContentLinkProvider><AttachmentReadContextProvider context={{ type: 'card', id: 'card-1' }}>
    <CardRequestView request={request} collapseBlankLines attachmentImageVariant="cardCheckItem" />
  </AttachmentReadContextProvider></ContentLinkProvider>);
  expect(summary.getByText('첫 문단\n둘째 문단').props.children).toBe('첫 문단\n둘째 문단');
  expect(StyleSheet.flatten(summary.getByTestId('card-request-image-0').props.style)).toMatchObject({ width: 104, height: 60 });
  expect(summary.getByTestId('card-request-image-0').props.resizeMode).toBe('cover');
  fireEvent.press(summary.getByTestId('card-request-image-0'));
  expect(summary.getByTestId('attachment-preview-modal')).toBeTruthy();
  summary.unmount();

  const external = 'https://other.test/photo.png';
  const outside = render(<CardRequestView request={`첨부: 외부(${external})`} attachmentImageVariant="cardCheckItem" />);
  fireEvent.press(outside.getByTestId('card-request-image-0'));
  expect(within(outside.getByTestId('image-viewer-pages')).UNSAFE_getByType(Image).props.source.uri).toBe(external);
});
