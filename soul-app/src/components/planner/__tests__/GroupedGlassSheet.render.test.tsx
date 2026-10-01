import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import {
  GroupedGlassRow,
  GroupedGlassSheet,
  resolveGroupedRowBackground,
} from '../GroupedGlassSheet';
import { useSettingsStore } from '../../../store/settingsStore';

test.each([
  ['dark', 'rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.06)', 'rgba(255, 255, 255, 0.12)'],
  ['light', 'rgba(0, 0, 0, 0.08)', 'rgba(0, 0, 0, 0.06)', 'rgba(0, 0, 0, 0.1)'],
] as const)('%s grouped sheet는 idle·pressed·divider·stroke exact 역할을 실제 렌더한다', (
  mode,
  dividerColor,
  pressedColor,
  strokeColor,
) => {
  useSettingsStore.setState({ appearance: mode });
  const screen = render(
    <GroupedGlassSheet testID="grouped-sheet">
      <GroupedGlassRow testID="first" onPress={jest.fn()}><Text>첫째</Text></GroupedGlassRow>
      <GroupedGlassRow testID="second" testOnlyPressed onPress={jest.fn()}>
        <Text>둘째</Text>
      </GroupedGlassRow>
    </GroupedGlassSheet>,
  );

  expect(StyleSheet.flatten(screen.getByTestId('grouped-sheet').props.style))
    .toMatchObject({ borderColor: strokeColor });
  expect(StyleSheet.flatten(screen.getAllByTestId('grouped-glass-divider')[0].props.style))
    .toMatchObject({ backgroundColor: dividerColor });
  expect(StyleSheet.flatten(screen.getByTestId('first').props.style))
    .toMatchObject({ backgroundColor: 'transparent' });
  expect(StyleSheet.flatten(screen.getByTestId('second').props.style))
    .toMatchObject({ backgroundColor: pressedColor });
  expect(resolveGroupedRowBackground({
    selected: false, pressed: false, interactive: true,
    selectedColor: 'selected', pressedColor: 'pressed',
  })).toBe('transparent');
  expect(resolveGroupedRowBackground({
    selected: false, pressed: true, interactive: true,
    selectedColor: 'selected', pressedColor: 'pressed',
  })).toBe('pressed');
});

test('inherited surface는 행·divider를 유지하면서 별도 glass frame을 만들지 않는다', () => {
  const screen = render(
    <GroupedGlassSheet surface="inherited" testID="inherited-sheet">
      <GroupedGlassRow testID="inherited-first"><Text>첫째</Text></GroupedGlassRow>
      <GroupedGlassRow testID="inherited-second"><Text>둘째</Text></GroupedGlassRow>
    </GroupedGlassSheet>,
  );

  expect(StyleSheet.flatten(screen.getByTestId('inherited-sheet').props.style))
    .toMatchObject({ overflow: 'hidden' });
  expect(StyleSheet.flatten(screen.getByTestId('inherited-sheet').props.style).borderColor)
    .toBeUndefined();
  expect(screen.getAllByTestId('grouped-glass-divider')).toHaveLength(1);
  expect(screen.getByTestId('inherited-first')).toBeTruthy();
  expect(screen.getByTestId('inherited-second')).toBeTruthy();
});
