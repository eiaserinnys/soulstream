import React from 'react';
import { act, render } from '@testing-library/react-native';
import { Appearance, Platform } from 'react-native';
import { AppAppearanceSync } from '../AppAppearanceSync';
import { useSettingsStore } from '../../store/settingsStore';

describe('AppAppearanceSync', () => {
  let setColorScheme: jest.SpyInstance;

  beforeEach(() => {
    useSettingsStore.setState({ appearance: 'system' });
    setColorScheme = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setColorScheme.mockRestore();
  });

  test.each([
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'unspecified'],
  ] as const)('iOS에서 appearance %s는 %s로 동기화한다', (appearance, expected) => {
    useSettingsStore.setState({ appearance });

    render(<AppAppearanceSync />);

    expect(setColorScheme).toHaveBeenLastCalledWith(expected);
  });

  test('appearance가 바뀌면 새 스킴으로 다시 동기화한다', async () => {
    useSettingsStore.setState({ appearance: 'dark' });
    render(<AppAppearanceSync />);
    expect(setColorScheme).toHaveBeenLastCalledWith('dark');

    await act(async () => { useSettingsStore.setState({ appearance: 'light' }); });

    expect(setColorScheme).toHaveBeenLastCalledWith('light');
  });

  test('웹에서는 Appearance를 건드리지 않는다', () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    useSettingsStore.setState({ appearance: 'dark' });

    render(<AppAppearanceSync />);

    expect(setColorScheme).not.toHaveBeenCalled();
  });
});
