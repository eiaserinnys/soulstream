import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { CardRequestView } from '../CardRequestView';

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

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
  act(() => useAuthStore.setState({ jwt: null }));
});
