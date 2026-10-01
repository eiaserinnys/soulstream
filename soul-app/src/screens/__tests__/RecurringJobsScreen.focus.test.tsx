import React from 'react';
import { act, render } from '@testing-library/react-native';

let mockOnFocus: (() => void) | undefined;
const mockListProps = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: jest.fn((callback) => { mockOnFocus = callback; }),
}));
jest.mock('../../theme', () => ({
  useTokens: () => ({ foundation: { pageInset: 0 } }),
}));
jest.mock('../../components/settings/RecurringJobViews', () => ({
  RecurringJobsList: (props: unknown) => {
    mockListProps(props);
    return null;
  },
}));

import { useSettingsStore } from '../../store/settingsStore';
import { RecurringJobsScreen } from '../RecurringJobsScreen';

test('phone list receives a new refresh key after returning to its focused route', () => {
  mockListProps.mockClear();
  useSettingsStore.setState({ serverUrl: 'https://soul.test' });
  render(<RecurringJobsScreen navigation={{ navigate: jest.fn() }} />);

  expect(mockListProps).toHaveBeenLastCalledWith(expect.objectContaining({ refreshKey: 0 }));
  act(() => mockOnFocus?.());
  expect(mockListProps).toHaveBeenLastCalledWith(expect.objectContaining({ refreshKey: 0 }));
  act(() => mockOnFocus?.());
  expect(mockListProps).toHaveBeenLastCalledWith(expect.objectContaining({ refreshKey: 1 }));
});
