import React from 'react';
import { act, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { HomeComposerSpacer } from '../HomeComposerSpacer';
import { useUIStore } from '../../../store/uiStore';

beforeEach(() => {
  useUIStore.setState({ floatingComposerBottomInset: 0 });
});

test('spacer follows the shared home composer measurement and preserves the preceding gap', () => {
  const screen = render(<HomeComposerSpacer enabled precedingGap={8} testID="composer-spacer" />);
  expect(screen.queryByTestId('composer-spacer')).toBeNull();

  for (const height of [120, 160, 5]) {
    act(() => { useUIStore.getState().setFloatingComposerBottomInset(height); });
    expect(StyleSheet.flatten(screen.getByTestId('composer-spacer').props.style)).toMatchObject({
      height,
      marginTop: -8,
      flexShrink: 0,
    });
  }

  act(() => { useUIStore.getState().setFloatingComposerBottomInset(0); });
  expect(screen.queryByTestId('composer-spacer')).toBeNull();
});

test('disabled spacer stays absent while a composer measurement is present', () => {
  useUIStore.setState({ floatingComposerBottomInset: 120 });
  const screen = render(<HomeComposerSpacer enabled={false} precedingGap={8} testID="composer-spacer" />);

  expect(screen.queryByTestId('composer-spacer')).toBeNull();
});
