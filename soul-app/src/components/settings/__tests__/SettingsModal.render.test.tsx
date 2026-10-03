import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

let mockDeviceType: 'phone' | 'tabletPortrait' = 'phone';
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (type: string) => type === 'phone' ? 'phone' : 'tablet',
}));
jest.mock('../../../screens/SettingsScreen', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { SettingsScreen: (props: any) => React.createElement(View, { testID: 'settings-child', ...props }) };
});
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));

import { SettingsModal } from '../SettingsModal';
import { createApiClient } from '../../../api/client';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';

const api = { getAuthStatus: jest.fn() };

beforeEach(() => {
  (createApiClient as jest.Mock).mockReturnValue(api);
  api.getAuthStatus.mockReset();
  useAuthStore.setState({ jwt: null });
  useSettingsStore.setState({ serverUrl: '' });
});

test('wide iPad uses a page sheet with provider-neutral sidebar and detail', () => {
  mockDeviceType = 'tabletPortrait';
  const onClose = jest.fn();
  const screen = render(<SettingsModal visible onClose={onClose} />);
  expect(screen.getByTestId('settings-modal-safe-area')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('settings-modal-header').props.style))
    .toMatchObject({ paddingHorizontal: 20 });
  expect(StyleSheet.flatten(screen.getByTestId('settings-modal-close').props.style))
    .toMatchObject({ minWidth: 48, minHeight: 48 });
  expect(screen.UNSAFE_getByType(Modal).props.presentationStyle).toBe('pageSheet');
  expect(screen.getByTestId('settings-wide-layout')).toBeTruthy();
  expect(screen.getByText('에이전트와 모델')).toBeTruthy();
  expect(screen.getByTestId('settings-category-backends')).toBeTruthy();
  expect(screen.getByTestId('settings-child').props).toMatchObject({
    showTitle: false,
    flattened: true,
    category: 'display',
  });
  fireEvent.press(screen.getByTestId('settings-category-backends'));
  expect(screen.getByTestId('settings-child').props.category).toBe('backends');
  expect(screen.UNSAFE_getByType(Modal).props.supportedOrientations)
    .toEqual(['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']);
});

test('compact Stage Manager width collapses to the phone grouped flow', () => {
  mockDeviceType = 'phone';
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);

  expect(screen.UNSAFE_getByType(Modal).props.presentationStyle).toBe('pageSheet');
  expect(screen.queryByTestId('settings-wide-layout')).toBeNull();
  expect(screen.getByTestId('settings-category-backends')).toBeTruthy();
  expect(screen.getByTestId('settings-phone-index')).toBeTruthy();
  fireEvent.press(screen.getByTestId('settings-category-backends'));
  expect(screen.getByTestId('settings-child').props).toMatchObject({
    showTitle: false,
    flattened: true,
  });
  expect(screen.getByTestId('settings-child').props.category).toBe('backends');
  fireEvent.press(screen.getByLabelText('모든 설정으로 돌아가기'));
  expect(screen.getByTestId('settings-phone-index')).toBeTruthy();
});

test('admin status exposes the review policy on iPad and passes it to the detail', async () => {
  mockDeviceType = 'tabletPortrait';
  useAuthStore.setState({ jwt: 'native-jwt' });
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
  api.getAuthStatus.mockResolvedValue({
    authenticated: true,
    user: { email: 'admin@example.com', name: 'Admin', picture: '', isAdmin: true },
  });

  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  const category = await screen.findByTestId('settings-category-review-policy');
  fireEvent.press(category);

  await waitFor(() => expect(screen.getByTestId('settings-child').props).toMatchObject({
    category: 'review-policy',
    showAdmin: true,
  }));
  expect(api.getAuthStatus).toHaveBeenCalledTimes(1);
});

test('admin status exposes the review policy in the compact grouped flow', async () => {
  mockDeviceType = 'phone';
  useAuthStore.setState({ jwt: 'native-jwt' });
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
  api.getAuthStatus.mockResolvedValue({
    authenticated: true,
    user: { email: 'admin@example.com', name: 'Admin', picture: '', isAdmin: true },
  });

  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  const category = await screen.findByTestId('settings-category-review-policy');
  fireEvent.press(category);
  expect(screen.getByTestId('settings-child').props.showAdmin).toBe(true);
  expect(screen.getByTestId('settings-child').props.category).toBe('review-policy');
});
