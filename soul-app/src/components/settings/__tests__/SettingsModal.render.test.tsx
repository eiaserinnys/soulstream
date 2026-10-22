import React from 'react';
import { Modal, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
let mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockDimensions }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));
import { SettingsSurface } from '../SettingsSurface';
import { SettingsModal } from '../SettingsModal';
import { createApiClient } from '../../../api/client';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
const api = {
  listNodes: jest.fn().mockResolvedValue({ nodes: [] }),
  listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [] }),
  listNodeAgents: jest.fn().mockResolvedValue({ agents: [] }),
  listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
  getConfig: jest.fn().mockResolvedValue({ mode: 'single' }), getAuthStatus: jest.fn().mockResolvedValue({ authenticated: true, user: { isAdmin: true } }) };
beforeEach(() => { mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 }; jest.mocked(createApiClient).mockReturnValue(api as any); useAuthStore.setState({ jwt: null }); useSettingsStore.setState({ serverUrl: '' }); });
test('iPad page sheet bounds sibling sidebar/detail beneath its header', () => {
  mockDimensions.width = 1024;
  const screen = render(<SettingsModal visible onClose={jest.fn()}/>);
  expect(screen.UNSAFE_getByType(Modal).props.presentationStyle).toBe('pageSheet');
  expect(screen.getByTestId('settings-sidebar-scroll')).toBeTruthy();
  expect(screen.getByText('관리와 문제 해결')).toBeTruthy();
  expect(screen.getByTestId('settings-detail-display')).toBeTruthy();
  expect(screen.getAllByTestId('settings-modal-header')).toHaveLength(1);
  expect(screen.getByTestId('settings-safe-area').props.edges).toEqual({
    top: 'off',
    right: 'off',
    bottom: 'off',
    left: 'off',
  });
  expect(screen.getByTestId('settings-modal-safe-area').props.edges).toEqual({
    top: 'additive',
    right: 'additive',
    bottom: 'additive',
    left: 'additive',
  });
  expect(screen.getByTestId('settings-section-display').findAllByType(Text).some(text => text.props.children === '화면과 배경')).toBe(false);
  for (const surface of screen.UNSAFE_getAllByType(SettingsSurface)) expect(surface.props.flattened).toBe(true);
  expect(screen.UNSAFE_getByType(Modal).props.supportedOrientations).toEqual(['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']);
});
test('compact width opens the index, then returns from a detail without closing', () => {
  const onClose = jest.fn(); const screen = render(<SettingsModal visible onClose={onClose}/>);
  expect(screen.getByTestId('settings-phone-index')).toBeTruthy();
  fireEvent.press(screen.getByTestId('settings-category-connection'));
  expect(screen.getByTestId('settings-server-input')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('모든 설정으로 돌아가기'));
  expect(screen.getByTestId('settings-phone-index')).toBeTruthy(); expect(onClose).not.toHaveBeenCalled();
});

test('the open-on-start switch writes an account and server local preference immediately', async () => {
  const payload = Buffer.from(JSON.stringify({ email: 'review@example.com', sub: 'review@example.com', exp: 2_000_000_000 })).toString('base64url');
  useAuthStore.setState({ jwt: `header.${payload}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://soul.test', persistentSessionDevicePrefs: {} } as never);
  const screen = render(<SettingsModal visible onClose={jest.fn()}/>);
  fireEvent.press(screen.getByTestId('settings-category-display'));
  const toggle = screen.getByTestId('settings-persistent-session-open-on-start');
  expect(toggle.props.value).toBe(false);
  fireEvent(toggle, 'valueChange', true);
  await act(async () => {});
  screen.unmount();

  expect(useSettingsStore.getState().getPersistentSessionDevicePreference('https://soul.test', 'review@example.com'))
    .toEqual({
      openOnStart: true,
      lastSessionId: null,
      collapsedTaskGroups: ['todo'],
      showWeeklyUsage: false,
      weeklyUsageNodeSelection: null,
    });
});

import { LayoutContinuityProvider, useLayoutContinuity } from '../../../navigation/LayoutContinuityContext';
import { SETTINGS_WORKSPACE_CONTINUITY_KEY } from '../../../navigation/settingsWorkspaceContinuity';
import { SettingsScreen } from '../../../screens/SettingsScreen';

test('settings remount restores the recurring editor and an explicit category takes priority', async () => {
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
  function Seed() {
    const continuity = useLayoutContinuity();
    React.useEffect(() => {
      continuity.setViewState(SETTINGS_WORKSPACE_CONTINUITY_KEY, {
        category: 'recurring-jobs', jobs: { kind: 'editor' }, persistent: { kind: 'list' },
      });
    }, [continuity]);
    return null;
  }
  const shell = (shown: boolean, explicit = false) => <LayoutContinuityProvider><Seed />
    {shown ? explicit ? <SettingsScreen category="connection" /> : <SettingsModal visible onClose={jest.fn()} /> : null}
  </LayoutContinuityProvider>;
  const view = render(shell(false));
  await act(async () => { view.rerender(shell(true)); });
  expect(view.getByLabelText('작업 이름')).toBeTruthy();
  await act(async () => { view.rerender(shell(false)); });
  await act(async () => { view.rerender(shell(true)); });
  expect(view.getByLabelText('작업 이름')).toBeTruthy();
  await act(async () => { view.rerender(shell(false)); });
  await act(async () => { view.rerender(shell(true, true)); });
  expect(view.getByTestId('settings-server-input')).toBeTruthy();
  view.unmount();
});
