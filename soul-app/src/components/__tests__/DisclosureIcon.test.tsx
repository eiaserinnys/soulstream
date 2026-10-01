import React from 'react';
import { AppState, StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { DARK_COLORS } from '../../theme/tokens';
import { useSettingsStore } from '../../store/settingsStore';
import { DisclosureIcon } from '../DisclosureIcon';

describe('DisclosureIcon', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    useSettingsStore.setState({ appearance: 'dark' });
  });

  test('explicit color가 tone보다 우선하고 기존 size를 유지한다', () => {
    const addEventListener = jest.spyOn(AppState, 'addEventListener');
    const screen = render(
      <DisclosureIcon expanded color="#8a8f98" tone="disabled" size={18} />,
    );
    expect(StyleSheet.flatten(screen.UNSAFE_getByType(Text).props.style)).toMatchObject({
      color: '#8a8f98',
      fontSize: 18,
      lineHeight: 18,
    });
    expect(addEventListener).not.toHaveBeenCalled();
  });

  test('color 미지정이면 tone, tone도 없으면 tertiary를 쓴다', () => {
    const toned = render(<DisclosureIcon expanded={false} tone="disabled" />);
    expect(StyleSheet.flatten(toned.UNSAFE_getByType(Text).props.style).color).toBe(
      DARK_COLORS.textDisabled,
    );
    toned.unmount();

    const defaulted = render(<DisclosureIcon expanded />);
    expect(StyleSheet.flatten(defaulted.UNSAFE_getByType(Text).props.style).color).toBe(
      DARK_COLORS.textTertiary,
    );
  });
});
