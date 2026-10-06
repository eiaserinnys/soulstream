import React from 'react';
import { render } from '@testing-library/react-native';
import { PersistentSessionStartup } from '../PersistentSessionStartup';
const mockInitialize = jest.fn();
jest.mock('../PersistentSessionContext', () => ({ usePersistentSessionHost: () => ({ initialize: mockInitialize }) }));
jest.mock('../../store/settingsStore', () => ({ useSettingsStore: { getState: () => ({ getPersistentSessionDevicePreference: () => ({ openOnStart: true }), serverUrl: 'https://public.invalid' }) } }));
jest.mock('../../store/authStore', () => ({ useAuthStore: { getState: () => ({ jwt: null }) } }));
beforeEach(() => mockInitialize.mockClear());

test('초기 준비가 끝난 인증 인스턴스에서 한 번 평가하고 홈·회전·선호 변경에는 재평가하지 않는다', () => {
  const open = jest.fn();
  const view = render(<PersistentSessionStartup ready={false} sessionIntent={false} onOpen={open} />);
  expect(mockInitialize).not.toHaveBeenCalled();
  view.rerender(<PersistentSessionStartup ready sessionIntent={false} onOpen={open} />);
  expect(mockInitialize).toHaveBeenCalledWith(open, true);
  view.rerender(<PersistentSessionStartup ready sessionIntent={false} onOpen={jest.fn()} />);
  expect(mockInitialize).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<PersistentSessionStartup ready sessionIntent={false} onOpen={open} />);
  expect(mockInitialize).toHaveBeenCalledTimes(2);
});
test('초기 알림·세션 링크가 있으면 초상 자료만 읽고 시작 화면 이동은 건너뛴다', () => {
  const open = jest.fn();
  render(<PersistentSessionStartup ready sessionIntent onOpen={open} />);
  expect(mockInitialize).toHaveBeenCalledWith(open, false);
});
