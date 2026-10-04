import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestMediaLibraryPermissionsAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));
import { createApiClient } from '../../api/client';
import { SettingsScreen } from '../SettingsScreen';
import { useSettingsStore } from '../../store/settingsStore';

const api = {
  getConfig: jest.fn(),
  listNodes: jest.fn(),
};

beforeEach(() => {
  mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
  (createApiClient as jest.Mock).mockReturnValue(api);
  api.getConfig.mockReset().mockResolvedValue({ mode: 'single' });
  api.listNodes.mockReset();
  useSettingsStore.setState({
    serverUrl: 'https://soul.test',
    serverType: 'orchestrator',
    nodeId: '',
    appearance: 'system',
    wallpaper: { mode: 'bokeh' },
  });
});

test.each([
  ['phone/fontScale1', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44],
  ['iPad/fontScale2', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48],
] as const)('%s Settings separates visual controls from hit frames and keeps adaptive form rhythm', async (
  _label,
  dimensions,
  hitTarget,
) => {
  mockDimensions = dimensions;
  useSettingsStore.setState({
    wallpaper: { mode: 'photo', customImage: 'file:///preview.jpg' },
  });
  const screen = render(<SettingsScreen showTitle={false} category="display" />);
  await waitFor(() => expect(api.getConfig).toHaveBeenCalled());

  const segmentHit = style(
    screen.getByTestId('settings-segment-appearance-system').props.style,
  );
  const segmentVisual = style(
    screen.getByTestId('settings-segment-appearance-system-visual').props.style,
  );
  expect(segmentHit).toMatchObject({ minHeight: hitTarget });
  expect(segmentHit).not.toHaveProperty('height');
  expect(segmentVisual).toMatchObject({ minHeight: 40 });
  expect(segmentVisual).not.toHaveProperty('height');
  const preview = style(screen.getByTestId('settings-wallpaper-preview-frame').props.style);
  expect(preview.width).toBe('100%'); expect(preview.aspectRatio).toBe(16 / 9);
  const index = screen.queryByLabelText('모든 설정으로 돌아가기'); if (index) fireEvent.press(index);
  fireEvent.press(screen.getByTestId('settings-category-connection'));
  for (const id of ['settings-server-input', 'settings-test-connection', 'settings-save']) expect(style(screen.getByTestId(id).props.style)).not.toHaveProperty('height');
  expect(style(screen.getByTestId('settings-server-input').props.style).minHeight).toBe(52);
  expect(screen.getByTestId('settings-save').props.accessibilityLabel).toBe('저장');
  const content = style(screen.getByTestId('settings-detail-connection').props.contentContainerStyle);
  expect(content.paddingHorizontal).toBe(20);

});

test('connection failure is announced and remains a secondary action', async () => {
  api.getConfig
    .mockResolvedValueOnce({ mode: 'single' })
    .mockRejectedValueOnce(new Error('연결 끊김'));
  const screen = render(<SettingsScreen showTitle={false} category="connection" />);
  await waitFor(() => expect(api.getConfig).toHaveBeenCalledTimes(1));

  fireEvent.press(screen.getByTestId('settings-test-connection'));

  const error = await screen.findByText(/연결 실패:/);
  expect(error.props.accessibilityRole).toBe('alert');
  expect(screen.getByTestId('settings-test-connection').props.accessibilityLabel)
    .toBe('연결 확인');
});

function style(value: unknown) {
  return StyleSheet.flatten(value as never) as Record<string, unknown>;
}
