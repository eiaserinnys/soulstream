const mockUseWindowDimensions = jest.fn();

jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (specifics: Record<string, unknown>) =>
      specifics.ios ?? specifics.native ?? specifics.default,
  },
  TurboModuleRegistry: {
    get: () => null,
  },
  useWindowDimensions: () => mockUseWindowDimensions(),
}));

import { useDeviceType } from '../useDeviceType';

describe('useDeviceType Dynamic Type boundary', () => {
  test.each([
    [{ width: 390, height: 844, fontScale: 1 }, 'phone'],
    [{ width: 390, height: 844, fontScale: 2 }, 'phone'],
    [{ width: 1024, height: 1366, fontScale: 1 }, 'tabletPortrait'],
    [{ width: 1024, height: 1366, fontScale: 2 }, 'tabletPortrait'],
    [{ width: 1366, height: 1024, fontScale: 1 }, 'tabletLandscape'],
    [{ width: 1366, height: 1024, fontScale: 2 }, 'tabletLandscape'],
  ] as const)('%j classifies as %s without coupling device type to fontScale', (dimensions, expected) => {
    mockUseWindowDimensions.mockReturnValue(dimensions);
    expect(useDeviceType()).toBe(expected);
  });
});
