import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { AutomaticRefreshIndicator } from '../AutomaticRefreshIndicator';

test('자동 갱신 표시의 회전은 스피너 상자 안에 머문다', () => {
  const screen = render(<AutomaticRefreshIndicator testID="refresh" />);
  expect(StyleSheet.flatten(screen.getByTestId('refresh').props.style).overflow).toBe('hidden');
});
