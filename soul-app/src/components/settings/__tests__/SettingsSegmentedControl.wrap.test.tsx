jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { SettingsSegmentedControl } from '../SettingsSegmentedControl';
import { CompletedCardFilters } from '../../planner/CompletedCardFilters';
import type { CompletedBrowser } from '../../../hooks/useCompletedCards';

const options = [{ value: '7', label: '지난 7일' }, { value: 'custom', label: '기간 지정' }];

afterEach(() => jest.restoreAllMocks());

test('web buttons expose both selected and unselected states without the browser outline', () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const screen = render(<SettingsSegmentedControl id="accessible" value="7" options={options} onChange={jest.fn()} />);
  // jest-expo renders native hosts, which drop web-only aria-pressed props.
  // Check the public TouchableOpacity boundary here; Chromium checks the DOM.
  const [selected, other] = screen.UNSAFE_getAllByType(TouchableOpacity);
  expect(selected.props['aria-pressed']).toBe(true);
  expect(other.props['aria-pressed']).toBe(false);
  expect(other.props.accessibilityState).toMatchObject({ selected: false });
  expect(StyleSheet.flatten(other.props.style)).toMatchObject({ outlineWidth: 0 });
});

test('focus highlights the rounded visual without selecting it and clears on blur', () => {
  const onChange = jest.fn();
  const screen = render(<SettingsSegmentedControl id="focus" value="7" options={options} onChange={onChange} />);
  const button = screen.getByTestId('settings-segment-focus-custom');
  fireEvent(button, 'focus');
  const ring = screen.getByTestId('settings-segment-focus-custom-focus');
  const style = StyleSheet.flatten(ring.props.style);
  expect(style.borderWidth).toBe(2);
  expect(style.borderColor).not.toBe('transparent');
  expect(style.borderRadius).toBe(StyleSheet.flatten(screen.getByTestId('settings-segment-focus-custom-visual').props.style).borderRadius);
  expect(button.props.accessibilityState).toMatchObject({ selected: false });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent(button, 'blur');
  expect(StyleSheet.flatten(screen.getByTestId('settings-segment-focus-custom-focus').props.style).borderColor).toBe('transparent');
});

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
