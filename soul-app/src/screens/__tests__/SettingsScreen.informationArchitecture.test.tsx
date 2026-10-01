import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

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
};

beforeEach(() => {
  (createApiClient as jest.Mock).mockReturnValue(api);
  api.getConfig.mockReset().mockResolvedValue({ mode: 'single', nodeId: 'node-a' });
  api.listNodes.mockReset();
  api.getClaudeAuthStatus.mockReset().mockResolvedValue({ has_token: false });
  api.getClaudeProfile.mockReset().mockResolvedValue(null);
  api.getProviderUsage.mockReset();
  api.getAuthStatus.mockReset();
  useAuthStore.setState({ jwt: null });
  useSettingsStore.setState({
    serverUrl: 'https://soul.test',
    serverType: 'orchestrator',
    nodeId: '',
    appearance: 'system',
    wallpaper: { mode: 'bokeh' },
  });
});

test('phone settings resolves bearer admin status and exposes the review policy', async () => {
  useAuthStore.setState({ jwt: 'native-jwt' });
  api.getAuthStatus.mockResolvedValue({
    authenticated: true,
    user: {
      email: 'admin@example.com',
      name: 'Admin',
      picture: '',
      isAdmin: true,
    },
  });

  const screen = render(<SettingsScreen showTitle={false} />);

  expect(await screen.findByTestId('review-policy-section')).toBeTruthy();
  expect(api.getAuthStatus).toHaveBeenCalledTimes(1);
  expect(createApiClient).toHaveBeenCalledWith('https://soul.test', {
    authScope: expect.objectContaining({
      serverUrl: 'https://soul.test',
      jwt: 'native-jwt',
    }),
  });
  const tree = JSON.stringify(screen.toJSON());
  expect(tree.indexOf('settings-section-backends')).toBeLessThan(
    tree.indexOf('review-policy-section'),
  );
  expect(tree.indexOf('review-policy-section')).toBeLessThan(
    tree.indexOf('settings-section-diagnostics'),
  );
});

test('phone settings keeps the review policy hidden from a non-admin', async () => {
  useAuthStore.setState({ jwt: 'native-jwt' });
  api.getAuthStatus.mockResolvedValue({
    authenticated: true,
    user: {
      email: 'member@example.com',
      name: 'Member',
      picture: '',
      isAdmin: false,
    },
  });

  const screen = render(<SettingsScreen showTitle={false} />);

  await waitFor(() => expect(api.getAuthStatus).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('review-policy-section')).toBeNull();
});

test('phone settings uses one provider-neutral grouped flow in the agreed order', async () => {
  const screen = render(<SettingsScreen showTitle={false} />);
  await waitFor(() => expect(api.getConfig).toHaveBeenCalled());

  expect(screen.getByTestId('settings-section-display')).toBeTruthy();
  expect(screen.getByTestId('settings-section-connection')).toBeTruthy();
  expect(screen.getByTestId('settings-section-backends')).toBeTruthy();
  expect(screen.getByTestId('settings-section-recurring-jobs')).toBeTruthy();
  expect(screen.getByTestId('settings-section-diagnostics')).toBeTruthy();
  expect(screen.getByText('AI 백엔드')).toBeTruthy();
  expect(screen.queryByTestId('settings-section-claude')).toBeNull();

  const tree = JSON.stringify(screen.toJSON());
  expect(tree.indexOf('settings-section-display')).toBeLessThan(
    tree.indexOf('settings-section-connection'),
  );
  expect(tree.indexOf('settings-section-connection')).toBeLessThan(
    tree.indexOf('settings-section-backends'),
  );
  expect(tree.indexOf('settings-section-backends')).toBeLessThan(
    tree.indexOf('settings-section-recurring-jobs'),
  );
  expect(tree.indexOf('settings-section-recurring-jobs')).toBeLessThan(
    tree.indexOf('settings-section-diagnostics'),
  );
});

test('phone settings opens the dedicated recurring-job stack entry', async () => {
  const onOpenRecurringJobs = jest.fn();
  const screen = render(
    <SettingsScreen showTitle={false} onOpenRecurringJobs={onOpenRecurringJobs} />,
  );
  await waitFor(() => expect(api.getConfig).toHaveBeenCalled());

  fireEvent.press(screen.getByTestId('open-recurring-jobs'));

  expect(onOpenRecurringJobs).toHaveBeenCalledTimes(1);
});

test('wallpaper choices are a two-column tile grid with a non-color selected mark', async () => {
  const screen = render(<SettingsScreen showTitle={false} />);
  await waitFor(() => expect(api.getConfig).toHaveBeenCalled());

  expect(screen.getByTestId('settings-wallpaper-grid').props.style).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ flexDirection: 'row', flexWrap: 'wrap' }),
    ]),
  );
  expect(screen.getByTestId('settings-wallpaper-bokeh-checkmark')).toBeTruthy();
  expect(
    screen.getByTestId('settings-wallpaper-bokeh').props.accessibilityState,
  ).toEqual(expect.objectContaining({ selected: true }));
  expect(screen.queryByTestId('settings-wallpaper-metal-checkmark')).toBeNull();
});
