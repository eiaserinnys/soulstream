import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';
import { SettingsModal } from '../SettingsModal';
import { createApiClient } from '../../../api/client';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('expo-image-picker', () => ({ MediaTypeOptions: { Images: 'Images' }, requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
// Unrelated runtime/diagnostic services are outside this local settings interaction.
jest.mock('../AIBackendSettingsSection', () => ({ AIBackendSettingsSection: () => null }));
jest.mock('../DiagnosticsSettingsSection', () => ({ DiagnosticsSettingsSection: () => null }));
jest.mock('../../../theme/useDeviceType', () => ({ useDeviceType: () => 'phone', deviceTypeToBaseKey: () => 'phone' }));
const api = {
  listNodes: jest.fn().mockResolvedValue({ nodes: [] }),
  getConfig: jest.fn().mockResolvedValue({ mode: 'single' }),
  getAuthStatus: jest.fn().mockResolvedValue({ authenticated: true, user: { isAdmin: true } }),
  getSessionReviewPolicy: jest.fn().mockResolvedValue({ policy: { sourceAllowlist: ['slack'], version: 1 }, sourceCatalog: [], conditionalRules: [] }),
  listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [] }),
  putUserPreferences: jest.fn(), uploadUserBackground: jest.fn(),
};
beforeEach(() => {
  jest.clearAllMocks(); jest.mocked(createApiClient).mockReturnValue(api as any);
  useSettingsStore.setState({ serverUrl: 'https://settings.test', wallpaper: { mode: 'photo', customImage: 'file://before.jpg' } });
  useAuthStore.setState({ jwt: 'test-auth' });
});
test('폰 목록으로 돌아갔다가 같은 검수 정책을 열어도 미저장 입력을 유지한다', async () => {
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  fireEvent.press(await screen.findByTestId('settings-category-review-policy'));
  const input = await screen.findByPlaceholderText('예: external-llm');
  fireEvent.changeText(input, 'unsaved-source');
  fireEvent.press(screen.getByLabelText('모든 설정으로 돌아가기'));
  fireEvent.press(screen.getByTestId('settings-category-review-policy'));
  expect(screen.getByPlaceholderText('예: external-llm').props.value).toBe('unsaved-source');
  expect(api.getSessionReviewPolicy).toHaveBeenCalledTimes(1);
});
test('사진 선택 연타와 취소는 기존 배경을 보존한다', async () => {
  let resolve!: (value: any) => void;
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockImplementation(() => new Promise(yes => { resolve = yes; }));
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: true, assets: null });
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  fireEvent.press(screen.getByTestId('settings-category-display'));
  const button = screen.getByTestId('settings-upload-background');
  act(() => { fireEvent.press(button); fireEvent.press(button); });
  expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ granted: true }));
  expect(useSettingsStore.getState().wallpaper.customImage).toBe('file://before.jpg');
  expect(api.uploadUserBackground).not.toHaveBeenCalled();
});

test('폰 설정 목록을 왕복해도 반복 작업 편집기의 이름과 내용을 유지한다', async () => {
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  fireEvent.press(screen.getByTestId('settings-category-recurring-jobs'));
  fireEvent.press(await screen.findByText('새 작업'));
  await act(async () => {});
  fireEvent.changeText(screen.getByLabelText('작업 이름'), '보존할 이름');
  fireEvent.changeText(screen.getByLabelText('작업 내용'), '보존할 내용');
  fireEvent.press(screen.getByLabelText('모든 설정으로 돌아가기'));
  fireEvent.press(screen.getByTestId('settings-category-recurring-jobs'));
  expect(screen.getByLabelText('작업 이름').props.value).toBe('보존할 이름');
  expect(screen.getByLabelText('작업 내용').props.value).toBe('보존할 내용');
});
