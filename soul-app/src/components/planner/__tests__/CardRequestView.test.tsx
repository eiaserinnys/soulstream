import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { CardRequestView } from '../CardRequestView';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

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
