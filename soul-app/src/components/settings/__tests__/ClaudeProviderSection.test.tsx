import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
}));

import * as WebBrowser from 'expo-web-browser';
import { createApiClient } from '../../../api/client';
import { ClaudeProviderSection } from '../ClaudeProviderSection';

const api = {
  getClaudeAuthStatus: jest.fn(),
  getClaudeProfile: jest.fn(),
  startClaudeAuth: jest.fn(),
  submitClaudeCode: jest.fn(),
  deleteClaudeToken: jest.fn(),
};
const onRefreshUsage = jest.fn();
const onTokenDeleted = jest.fn();

beforeEach(() => {
  (createApiClient as jest.Mock).mockReturnValue(api);
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getClaudeAuthStatus.mockResolvedValue({ has_token: false });
  api.getClaudeProfile.mockResolvedValue(null);
  onRefreshUsage.mockReset();
  onTokenDeleted.mockReset();
  (WebBrowser.openBrowserAsync as jest.Mock)
    .mockReset()
    .mockResolvedValue({ type: 'cancel' });
});

function renderProvider() {
  return render(
    <ClaudeProviderSection
      nodeId="node-x"
      serverUrl="https://soul.test"
      usage={null}
      loadingUsage={false}
      usageError={null}
      onRefreshUsage={onRefreshUsage}
      onTokenDeleted={onTokenDeleted}
    />,
  );
}

test('Claude auth and profile remain provider-local', async () => {
  api.getClaudeAuthStatus.mockResolvedValueOnce({ has_token: true });
  api.getClaudeProfile.mockResolvedValueOnce({
    email: 'user@example.com',
    display_name: 'User',
    has_claude_max: true,
  });
  const screen = renderProvider();

  expect(await screen.findByText('user@example.com')).toBeTruthy();
  expect(screen.getByText('Claude Max')).toBeTruthy();
  expect(api.getClaudeAuthStatus).toHaveBeenCalledWith('node-x');
  expect(api.getClaudeProfile).toHaveBeenCalledWith('node-x');
});

test('Claude actions keep secondary 48pt minimum and usage delegates upward', async () => {
  const screen = renderProvider();
  await screen.findByText('미인증');
  for (const testID of ['claude-login-action', 'claude-usage-action']) {
    const style = StyleSheet.flatten(screen.getByTestId(testID).props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style).not.toHaveProperty('height');
  }

  fireEvent.press(screen.getByTestId('claude-usage-action'));
  expect(onRefreshUsage).toHaveBeenCalledTimes(1);
});

test('Claude login opens the provider-specific OAuth URL', async () => {
  api.startClaudeAuth.mockResolvedValueOnce({
    authUrl: 'https://claude.ai/oauth/start?node=node-x',
  });
  const screen = renderProvider();
  fireEvent.press(await screen.findByTestId('claude-login-action'));

  await waitFor(() =>
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(
      'https://claude.ai/oauth/start?node=node-x',
    ),
  );
});

test('Claude authorization code submission preserves the existing API contract', async () => {
  api.startClaudeAuth.mockResolvedValueOnce({
    authUrl: 'https://claude.ai/oauth/start',
  });
  api.submitClaudeCode.mockResolvedValueOnce({ ok: true });
  api.getClaudeAuthStatus
    .mockResolvedValueOnce({ has_token: false })
    .mockResolvedValueOnce({ has_token: true });
  const screen = renderProvider();
  fireEvent.press(await screen.findByTestId('claude-login-action'));
  await waitFor(() =>
    expect(screen.getByTestId('claude-code-input')).toBeTruthy(),
  );
  const code = screen.getByLabelText('인증 코드');
  const before = StyleSheet.flatten(code.props.style).borderColor;
  fireEvent(code, 'focus');
  expect(StyleSheet.flatten(screen.getByLabelText('인증 코드').props.style).borderColor).not.toBe(before);
  fireEvent.changeText(code, ' code ');
  await act(async () => {
    fireEvent.press(screen.getByTestId('claude-code-confirm'));
  });

  await waitFor(() =>
    expect(api.submitClaudeCode).toHaveBeenCalledWith('node-x', 'code'),
  );
  expect(api.getClaudeAuthStatus).toHaveBeenCalledTimes(2);
});

test('Claude token deletion stays behind a destructive confirmation', async () => {
  api.getClaudeAuthStatus.mockResolvedValueOnce({ has_token: true });
  api.deleteClaudeToken.mockResolvedValueOnce({ ok: true });
  let buttons: any[] = [];
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, actions) => {
      buttons = actions ?? [];
    });
  const screen = renderProvider();
  fireEvent.press(await screen.findByTestId('claude-delete-action'));
  const destructive = buttons.find((button) => button.style === 'destructive');

  expect(destructive).toBeTruthy();
  await act(async () => {
    await destructive.onPress();
  });
  expect(api.deleteClaudeToken).toHaveBeenCalledWith('node-x');
  expect(onTokenDeleted).toHaveBeenCalledTimes(1);
  alert.mockRestore();
});
