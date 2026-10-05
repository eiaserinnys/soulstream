jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { AppState } from 'react-native';
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
    expect(screen.UNSAFE_getByType('Ionicons' as any).props).toMatchObject({
      name: 'chevron-up', color: '#8a8f98', size: 18,
    });
    expect(addEventListener).not.toHaveBeenCalled();
  });

  test('color 미지정이면 tone, tone도 없으면 tertiary를 쓴다', () => {
    const toned = render(<DisclosureIcon expanded={false} tone="disabled" />);
    expect(toned.UNSAFE_getByType('Ionicons' as any).props).toMatchObject({
      name: 'chevron-down', color: DARK_COLORS.textDisabled,
    });
    toned.unmount();

    const defaulted = render(<DisclosureIcon expanded />);
    expect(defaulted.UNSAFE_getByType('Ionicons' as any).props).toMatchObject({
      name: 'chevron-up', color: DARK_COLORS.textTertiary,
    });
  });
});
