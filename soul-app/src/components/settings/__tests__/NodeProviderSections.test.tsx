import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn().mockResolvedValue({ type: 'cancel' }),
}));

import { createApiClient } from '../../../api/client';
import { NodeProviderSections } from '../NodeProviderSections';
import { SettingsWorkspaceContext } from '../SettingsWorkspaceContext';
import { SettingsSurface } from '../SettingsSurface';
import type { SettingsCategory } from '../settingsCategories';

const api = {
  getClaudeAuthAccounts: jest.fn(),
  getClaudeAuthStatus: jest.fn(),
  getClaudeProfile: jest.fn(),
  getProviderUsage: jest.fn(),
  startClaudeAuth: jest.fn(),
  submitClaudeCode: jest.fn(),
  deleteClaudeToken: jest.fn(),
};

beforeEach(() => {
  (createApiClient as jest.Mock).mockReturnValue(api);
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getClaudeAuthAccounts.mockResolvedValue({
    mode: 'legacy',
    accounts: [],
    pool: null,
    fable_pool: null,
  });
  api.getClaudeAuthStatus.mockResolvedValue({ has_token: false });
  api.getClaudeProfile.mockResolvedValue(null);
  api.getProviderUsage.mockResolvedValue({
    generatedAt: '2026-07-26T00:00:00.000Z',
    providers: {
      claude: {
        status: 'not_configured',
        source: '',
        planType: null,
        quotas: [],
      },
      codex: {
        status: 'auto',
        source: 'codex-api',
        planType: 'pro',
        quotas: [
          {
            id: 'codex:7d',
            label: '7일',
            window: '7d',
            unit: 'percent',
            used: null,
            remaining: null,
            limit: null,
            usedPercent: 42,
            remainingPercent: 58,
            resetAt: null,
            model: null,
            source: 'codex-api',
          },
        ],
      },
      gemini: {
        status: 'not_configured',
        source: '',
        planType: null,
        quotas: [],
      },
      antigravity: { status: 'not_configured', source: '', planType: null, quotas: [] },
    },
  });
});

test('a node composes separate Claude and Codex provider sections', async () => {
  const screen = render(
    <NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" />,
  );

  expect(screen.getByTestId('backend-provider-claude')).toBeTruthy();
  expect(screen.getByTestId('backend-provider-codex')).toBeTruthy();
  expect(screen.getByTestId('backend-provider-antigravity')).toBeTruthy();
  expect(screen.getByText('Claude Code')).toBeTruthy();
  expect(screen.getByText('Codex')).toBeTruthy();
  await waitFor(() =>
    expect(api.getClaudeAuthStatus).toHaveBeenCalledWith('node-a'),
  );
});

test('Antigravity uses the existing usage action, failure feedback and retry', async () => {
  const screen = render(<NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" />);
  api.getProviderUsage.mockRejectedValueOnce(new Error('offline'));
  fireEvent.press(screen.getByTestId('backend-provider-antigravity-usage-action'));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(api.getProviderUsage).toHaveBeenCalledWith('node-a');
  fireEvent.press(screen.getByTestId('backend-provider-antigravity-usage-action'));
  expect(await screen.findByTestId('usage-provider-antigravity')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('Codex usage remains available while Claude is unauthenticated', async () => {
  const screen = render(
    <NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" />,
  );
  await waitFor(() => expect(screen.getByText('미인증')).toBeTruthy());

  fireEvent.press(screen.getByTestId('backend-provider-codex-usage-action'));

  await waitFor(() => expect(api.getProviderUsage).toHaveBeenCalledWith('node-a'));
  expect(await screen.findByTestId('usage-provider-codex')).toBeTruthy();
  expect(await screen.findByTestId('usage-bar-codex:7d')).toBeTruthy();
  expect(screen.queryByText('Codex 재로그인')).toBeNull();
  expect(screen.queryByText('준비 중')).toBeNull();
});

test('an older worker without Antigravity can refresh after another provider was loaded', async () => {
  const missing = { status: 'not_configured', source: '', planType: null, quotas: [] };
  api.getProviderUsage.mockResolvedValue({ generatedAt: '', providers: { claude: missing, codex: missing, gemini: missing } });
  const screen = render(<NodeProviderSections nodeId="legacy" serverUrl="https://soul.test" />);
  fireEvent.press(screen.getByTestId('backend-provider-codex-usage-action'));
  expect(await screen.findByTestId('usage-provider-codex')).toBeTruthy();
  await act(async () => {
    fireEvent.press(screen.getByTestId('backend-provider-antigravity-usage-action'));
    await Promise.resolve();
  });
  expect(api.getProviderUsage).toHaveBeenCalledTimes(2);
  expect(screen.getByTestId('backend-provider-antigravity')).toBeTruthy();
  expect(screen.getByText('사용량 데이터 없음')).toBeTruthy();
});

test('workspace pool uses the full-width card and hides the duplicate Claude usage card', async () => {
  api.getClaudeAuthAccounts.mockResolvedValue({
    mode: 'pool',
    accounts: [{ id: 'pool-one', email: 'pool@example.invalid', plan: null, enabled: true, priority: 1,
      auth_state: 'ok', usage: { five_hour: null, seven_day: null, fable_weekly: null }, observed_at: null,
      blocked: null, active_sessions: 0 }],
    pool: { available_count: 1, total_count: 1, best_weekly_remaining_percent: 71, best_weekly_resets_at: null, earliest_available_at: null },
    fable_pool: null,
  });
  const workspace = {
    category: 'backends' as const,
    wide: true,
    columns: true,
    jobs: { kind: 'list' as const }, setJobs: jest.fn(),
    persistent: { kind: 'list' as const }, setPersistent: jest.fn(),
    register: jest.fn(), changeConnection: (action: () => void) => action(),
    select: jest.fn(), guard: (_id: SettingsCategory, action: () => void) => action(),
  };
  const screen = render(<SettingsWorkspaceContext.Provider value={workspace}>
    <NodeProviderSections nodeId="node-a" serverUrl="https://soul.test" />
  </SettingsWorkspaceContext.Provider>);

  await screen.findByTestId('claude-account-pool-section');
  const surfaces = screen.UNSAFE_getAllByType(SettingsSurface);
  const poolSurface = StyleSheet.flatten(surfaces[0]!.props.style);
  const codexSurface = StyleSheet.flatten(surfaces[1]!.props.style);
  expect(poolSurface.width).toBe('100%');
  expect(codexSurface.width).toBe('47%');
  expect(screen.queryByText('Claude 사용량')).toBeNull();
  expect(screen.queryByTestId('claude-usage-action')).toBeNull();
});
