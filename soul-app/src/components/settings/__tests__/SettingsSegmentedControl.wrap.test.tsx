jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';
import { CompletedCardFilters } from '../../planner/CompletedCardFilters';
import type { CompletedBrowser } from '../../../hooks/useCompletedCards';

const options = [{ value: '7', label: '지난 7일' }, { value: 'custom', label: '기간 지정' }];

test('default settings segments retain equal widths and the existing label behavior', () => {
  const screen = render(<SettingsSegmentedControl id="default" value="7" options={options} onChange={jest.fn()} />);
  const button = screen.getByTestId('settings-segment-default-7');
  expect(StyleSheet.flatten(button.props.style)).toMatchObject({ flex: 1 });
  expect(StyleSheet.flatten(screen.UNSAFE_getAllByType(View)[0].props.style)).not.toHaveProperty('flexWrap');
  expect(StyleSheet.flatten(screen.getByTestId('settings-segment-default-7-visual').props.style)).toMatchObject({ width: '100%' });
  expect(screen.UNSAFE_getAllByType(Text)[0].props.numberOfLines).toBeUndefined();
});

test('wrap moves whole natural-width buttons and keeps each label on one line', () => {
  const onChange = jest.fn();
  const screen = render(<SettingsSegmentedControl wrap id="wrap" value="7" options={options} onChange={onChange} />);
  const button = screen.getByTestId('settings-segment-wrap-custom');
  expect(StyleSheet.flatten(screen.UNSAFE_getAllByType(View)[0].props.style)).toMatchObject({ flexWrap: 'wrap' });
  expect(StyleSheet.flatten(button.props.style)).toMatchObject({ flex: 0, flexShrink: 0, flexBasis: 'auto' });
  expect(StyleSheet.flatten(screen.getByTestId('settings-segment-wrap-custom-visual').props.style)).toMatchObject({ width: 'auto' });
  expect(screen.UNSAFE_getAllByType(Text).every(label => label.props.numberOfLines === 1)).toBe(true);
  fireEvent.press(button);
  expect(onChange).toHaveBeenCalledWith('custom');
});

test('the actual completed filter opts into wrapping and retains period selection', () => {
  const setPeriod = jest.fn();
  const browser = { period: '7', setPeriod, search: '', setSearch: jest.fn(), error: null } as unknown as CompletedBrowser;
  const screen = render(<CompletedCardFilters browser={browser} />);
  const custom = screen.getByTestId('settings-segment-completed-period-custom');
  expect(StyleSheet.flatten(custom.props.style)).toMatchObject({ flexShrink: 0 });
  fireEvent.press(custom);
  expect(setPeriod).toHaveBeenCalledWith('custom');
});
