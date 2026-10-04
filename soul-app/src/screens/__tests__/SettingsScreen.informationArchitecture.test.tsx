import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
jest.mock('../../components/settings/SessionReviewPolicySettingsSection', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    SessionReviewPolicySettingsSection: (props: unknown) =>
      React.createElement(View, {
        testID: 'review-policy-section',
        ...(props as object),
      }),
  };
});

import { createApiClient } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { SettingsScreen } from '../SettingsScreen';

const api = {
  getConfig: jest.fn(),
  listNodes: jest.fn(),
  getClaudeAuthStatus: jest.fn(),
  getClaudeProfile: jest.fn(),
  getProviderUsage: jest.fn(),
  getAuthStatus: jest.fn(),
  listOwnedAgents: jest.fn(),
  issueOwnedAgentKey: jest.fn(),
};

beforeEach(() => {
  (createApiClient as jest.Mock).mockReturnValue(api);
  api.getConfig.mockReset().mockResolvedValue({ mode: 'single', nodeId: 'node-a' });
  api.listNodes.mockReset();
  api.getClaudeAuthStatus.mockReset().mockResolvedValue({ has_token: false });
  api.getClaudeProfile.mockReset().mockResolvedValue(null);
  api.getProviderUsage.mockReset();
  api.getAuthStatus.mockReset();
  api.listOwnedAgents.mockReset();
  api.issueOwnedAgentKey.mockReset();
  useAuthStore.setState({ jwt: null });
  useSettingsStore.setState({
    serverUrl: 'https://soul.test',
    serverType: 'orchestrator',
    nodeId: '',
    appearance: 'system',
    wallpaper: { mode: 'bokeh' },
  });
});

test('admin categories are visible, and only the visited review form mounts', async () => {
  useAuthStore.setState({ jwt: 'native-jwt' });
  api.getAuthStatus.mockResolvedValue({ authenticated: true, user: { isAdmin: true } });
  const screen = render(<SettingsScreen/>);
  fireEvent.press(await screen.findByTestId('settings-category-review-policy'));
  expect(screen.getByTestId('review-policy-section')).toBeTruthy();
  expect(api.getAuthStatus).toHaveBeenCalledTimes(1);
});
test('opens owned agents from the settings list and clears a one-time key when leaving', async () => {
  api.listOwnedAgents.mockResolvedValue({ agents: [{
    id: 'fixture-agent', name: '예시 에이전트', enabled: true, ownerEmail: 'hidden@example.invalid',
    createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z', keys: [],
  }], existingConnection: { configured: true, registered: true, canRegister: false } });
  api.issueOwnedAgentKey.mockResolvedValue({ credential: {
    id: 'fixture-key', createdAt: '2026-10-04T00:00:00Z', lastUsedAt: null, revokedAt: null, isExistingConnection: false,
  }, token: 'fixture-one-time-token' });
  const screen = render(<SettingsScreen showAdmin={false}/>);
  await act(async () => {});

  fireEvent.press(screen.getByTestId('settings-category-owned-agents'));
  expect(await screen.findByLabelText('선택 예시 에이전트')).toBeTruthy();
  expect(api.listOwnedAgents).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('settings-active-footer')).toBeNull();

  fireEvent.press(screen.getByLabelText('새 키 발급'));
  expect(await screen.findByText('fixture-one-time-token')).toBeTruthy();

  if (screen.queryByTestId('settings-wide-layout')) fireEvent.press(screen.getByTestId('settings-category-display'));
  else fireEvent.press(screen.getByLabelText('모든 설정으로 돌아가기'));
  expect(screen.queryByText('fixture-one-time-token')).toBeNull();
  fireEvent.press(screen.getByTestId('settings-category-owned-agents'));
  expect(await screen.findByLabelText('선택 예시 에이전트')).toBeTruthy();
  expect(screen.queryByText('fixture-one-time-token')).toBeNull();
  expect(api.listOwnedAgents).toHaveBeenCalledTimes(3);
  expect(screen.queryByTestId('settings-active-footer')).toBeNull();
});
test('non-admin categories exclude the review policy', async () => {
  useAuthStore.setState({ jwt: 'native-jwt' }); api.getAuthStatus.mockResolvedValue({ authenticated: true, user: { isAdmin: false } });
  const screen = render(<SettingsScreen/>);
  await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('settings-category-review-policy')).toBeNull();
});
test('first connection exposes only connection fields, without adding native font or glass settings', async () => {
  const screen = render(<SettingsScreen connectionOnly/>);
  await act(async () => {});
  expect(screen.getByText('서버에 연결')).toBeTruthy(); expect(screen.getByTestId('settings-server-input')).toBeTruthy();
  expect(screen.queryByTestId('settings-section-display')).toBeNull(); expect(screen.queryByTestId('settings-section-backends')).toBeNull();
  expect(screen.queryByText(/폰트|글래스 강도/)).toBeNull();
});
test('wallpaper choices retain visual tiles and a non-color selected mark', async () => {
  const screen = render(<SettingsScreen category="display"/>);
  await act(async () => {});
  expect(screen.getByTestId('settings-wallpaper-bokeh-checkmark')).toBeTruthy();
  expect(screen.getByTestId('settings-wallpaper-bokeh').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('settings-wallpaper-photo-tile')).toBeTruthy();
});
