import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

const mockUseIdTokenAuthRequest = jest.fn();
jest.mock('expo-auth-session/providers/google', () => ({
  useIdTokenAuthRequest: (...args: unknown[]) => mockUseIdTokenAuthRequest(...args),
}));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { iosOauthClientId: 'ios-client' } } },
}));

import { LoginScreen } from '../LoginScreen';
import { useSettingsStore } from '../../store/settingsStore';

let response: any = null;
let promptAsync: jest.Mock;

beforeEach(() => {
  mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
  promptAsync = jest.fn().mockResolvedValue({ type: 'opened' });
  response = null;
  mockUseIdTokenAuthRequest.mockImplementation(() => [{}, response, promptAsync]);
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
});

test('safe-area login uses the shared primary action and remains retryable after prompt rejection', async () => {
  promptAsync.mockRejectedValueOnce(new Error('브라우저 실패'));
  const screen = render(<LoginScreen />);
  expect(screen.getByTestId('login-safe-area')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('login-action').props.style)).toMatchObject({
    minHeight: 52,
  });

  await act(async () => {
    fireEvent.press(screen.getByTestId('login-action'));
    await Promise.resolve();
  });
  expect(screen.getByText('브라우저 실패').props.accessibilityRole).toBe('alert');
  expect(screen.getByTestId('login-action').props.accessibilityState.disabled).toBe(false);
});

test('locked is terminal error while opened keeps the in-flight state', () => {
  response = { type: 'locked' };
  const locked = render(<LoginScreen />);
  expect(
    locked.getByText('다른 로그인 요청이 진행 중입니다. 잠시 후 다시 시도해주세요.')
      .props.accessibilityRole,
  ).toBe('alert');
  expect(locked.getByTestId('login-action').props.accessibilityState.disabled).toBe(false);
  locked.unmount();

  response = { type: 'opened' };
  const opened = render(<LoginScreen />);
  expect(opened.queryByText('다른 로그인 요청이 진행 중입니다. 잠시 후 다시 시도해주세요.'))
    .toBeNull();
});

test.each([
  ['phone/fontScale1', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44],
  ['iPad/fontScale2', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48],
] as const)('%s login keeps semantic inset, natural title expansion and hit target', (
  _label,
  dimensions,
  hitTarget,
) => {
  mockDimensions = dimensions;
  const screen = render(<LoginScreen />);
  const container = StyleSheet.flatten(screen.getByTestId('login-safe-area').props.style);
  const action = StyleSheet.flatten(screen.getByTestId('login-action').props.style);
  expect(container).toMatchObject({ paddingHorizontal: 20 });
  expect(container).not.toHaveProperty('height');
  expect(action.minWidth).toBeGreaterThanOrEqual(hitTarget);
  expect(action.minHeight).toBeGreaterThanOrEqual(hitTarget);
  expect(action).not.toHaveProperty('height');
  expect(screen.getByText('Soulstream').props.allowFontScaling).not.toBe(false);
});
