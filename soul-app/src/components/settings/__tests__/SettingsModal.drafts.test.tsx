import React from 'react';
import { Alert } from 'react-native';
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
let mockDeviceType = 'phone';
jest.mock('../../../theme/useDeviceType', () => ({ TABLET_BREAKPOINT: 700, useDeviceType: () => mockDeviceType, deviceTypeToBaseKey: (type: string) => type === 'phone' ? 'phone' : 'tablet' }));
const api = {
  listNodes: jest.fn().mockResolvedValue({ nodes: [] }),
  getConfig: jest.fn().mockResolvedValue({ mode: 'single' }),
  getAuthStatus: jest.fn().mockResolvedValue({ authenticated: true, user: { isAdmin: true } }),
  getSessionReviewPolicy: jest.fn().mockResolvedValue({ policy: { sourceAllowlist: ['slack'], version: 1 }, sourceCatalog: [], conditionalRules: [] }),
  listRecurringJobs: jest.fn().mockResolvedValue({ jobs: [] }),
  putUserPreferences: jest.fn(), uploadUserBackground: jest.fn(),
};
beforeEach(() => {
  mockDeviceType = 'phone';
  jest.clearAllMocks(); jest.mocked(createApiClient).mockReturnValue(api as any);
  useSettingsStore.setState({ serverUrl: 'https://settings.test', wallpaper: { mode: 'photo', customImage: 'file://before.jpg' } });
  useAuthStore.setState({ jwt: 'test-auth' });
});

test('wide and compact reflow retain the same connection input and selected target', async () => {
  mockDeviceType = 'tabletPortrait';
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  await act(async () => {});
  if (mockDeviceType === 'phone') fireEvent(screen.getByTestId('settings-safe-area'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  fireEvent(screen.getByTestId('settings-safe-area'), 'layout', { nativeEvent: { layout: { width: 1024 } } });
  fireEvent.press(screen.getByTestId('settings-category-connection'));
  expect(screen.getByTestId('settings-sidebar-scroll')).toBeTruthy();
  const input = screen.getByTestId('settings-server-input');
  fireEvent.changeText(input, 'https://unsaved.test');
  mockDeviceType = 'phone';
  fireEvent(screen.getByTestId('settings-safe-area'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  screen.rerender(<SettingsModal visible onClose={jest.fn()} />);
  expect(screen.getByTestId('settings-server-input').props.value).toBe('https://unsaved.test');
  expect(screen.getByTestId('settings-server-input')).toBe(input);
  fireEvent.press(screen.getByLabelText('모든 설정으로 돌아가기'));
  fireEvent.press(screen.getByTestId('settings-category-connection'));
  expect(screen.getByTestId('settings-server-input').props.value).toBe('https://unsaved.test');
});
test('폰 목록으로 돌아갔다가 같은 검수 정책을 열어도 미저장 입력을 유지한다', async () => {
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  await act(async () => {});
  if (mockDeviceType === 'phone') fireEvent(screen.getByTestId('settings-safe-area'), 'layout', { nativeEvent: { layout: { width: 390 } } });
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
  await act(async () => {});
  if (mockDeviceType === 'phone') fireEvent(screen.getByTestId('settings-safe-area'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  fireEvent.press(screen.getByTestId('settings-category-display'));
  const button = screen.getByTestId('settings-upload-background');
  act(() => { fireEvent.press(button); fireEvent.press(button); });
  expect(ImagePicker.requestMediaLibraryPermissionsAsync).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ granted: true }));
  expect(useSettingsStore.getState().wallpaper.customImage).toBe('file://before.jpg');
  expect(api.uploadUserBackground).not.toHaveBeenCalled();
});

test('배경 업로드 실패는 성공으로 표시하지 않고 정제된 오류만 보여준다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  jest.mocked(ImagePicker.requestMediaLibraryPermissionsAsync).mockResolvedValue({ granted: true } as never);
  jest.mocked(ImagePicker.launchImageLibraryAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file://chosen.jpg' }] } as never);
  api.uploadUserBackground.mockRejectedValueOnce(new Error('HTTP 403 Authorization: Bearer synthetic-auth Cookie=synthetic-cookie password=synthetic-password token=synthetic-token api_key=synthetic-key https://user:synthetic-userinfo@test.invalid/?key=synthetic-query'));
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  await act(async () => {});
  if (mockDeviceType === 'phone') fireEvent(screen.getByTestId('settings-safe-area'), 'layout', { nativeEvent: { layout: { width: 390 } } });
  fireEvent.press(screen.getByTestId('settings-category-display'));
  await act(async () => fireEvent.press(screen.getByTestId('settings-upload-background')));
  expect(api.putUserPreferences).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith('배경 저장 실패', 'HTTP 403\n민감한 정보가 포함될 수 있어 오류 원문은 표시하지 않습니다.');
  expect(JSON.stringify(alert.mock.calls)).not.toContain('synthetic-');
  expect(JSON.stringify(screen.toJSON())).not.toContain('synthetic-');
  expect(screen.getByTestId('settings-upload-background')).toBeEnabled();
  alert.mockRestore();
});

test('폰 설정 목록을 왕복해도 반복 작업 편집기의 이름과 내용을 유지한다', async () => {
  const screen = render(<SettingsModal visible onClose={jest.fn()} />);
  await act(async () => {});
  if (mockDeviceType === 'phone') fireEvent(screen.getByTestId('settings-safe-area'), 'layout', { nativeEvent: { layout: { width: 390 } } });
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


test('완료는 미저장 연결을 저장하지 않고 저장 화면 또는 버리기 선택을 기다린다', async () => {
  const onClose = jest.fn();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  const screen = render(<SettingsModal visible onClose={onClose}/>);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('settings-category-connection'));
  fireEvent.changeText(screen.getByTestId('settings-server-input'), 'https://pending.test');
  fireEvent.press(screen.getByTestId('settings-modal-close'));
  expect(onClose).not.toHaveBeenCalled();
  expect(useSettingsStore.getState().serverUrl).toBe('https://settings.test');
  const actions = alert.mock.calls[0][2]!;
  expect(actions.map(action => action.text)).toEqual(['계속 편집', '저장할 화면으로', '버리기']);
  act(() => actions.find(action => action.text === '버리기')!.onPress!());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(useSettingsStore.getState().serverUrl).toBe('https://settings.test');
  alert.mockRestore();
});

test('사진 로딩 오류는 렌더링 대체 그림만 바꾸고 설정과 인증 소스를 보존한다', async () => {
  const screen = render(<SettingsModal visible onClose={jest.fn()}/>);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('settings-category-display'));
  const image = screen.getByTestId('settings-wallpaper-preview');
  expect(image.props.source).toEqual({ uri: 'file://before.jpg' });
  fireEvent(image, 'error');
  expect(screen.getByTestId('settings-wallpaper-preview').props.source).toEqual(require('../../../../assets/settings-wallpaper-fallback.jpg'));
  expect(useSettingsStore.getState().wallpaper).toEqual({ mode: 'photo', customImage: 'file://before.jpg' });
  await act(async () => useSettingsStore.setState({ wallpaper: { mode: 'photo', customImage: 'file://next.jpg' } }));
  expect(screen.getByTestId('settings-wallpaper-preview').props.source).toEqual({ uri: 'file://next.jpg' });
  expect(api.putUserPreferences).not.toHaveBeenCalled();
});
