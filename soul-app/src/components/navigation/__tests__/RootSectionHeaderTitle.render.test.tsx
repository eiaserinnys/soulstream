jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { ROOT_SECTION_CONFIG } from '../../../navigation/rootSectionConfig';
import { RootSectionHeaderTitle } from '../RootSectionHeaderTitle';

test.each([
  ['phone/fontScale1', { width: 390, height: 844, scale: 3, fontScale: 1 }, 48],
  ['phone/fontScale2', { width: 390, height: 844, scale: 3, fontScale: 2 }, 48],
  ['iPad/fontScale1', { width: 1024, height: 1366, scale: 2, fontScale: 1 }, 48],
  ['iPad/fontScale2', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48],
] as const)('%s root header는 icon과 title의 Dynamic Type 계약을 공유한다', (_label, dimensions, minHeight) => {
  mockDimensions = dimensions;
  const screen = render(<RootSectionHeaderTitle section="DailyTab" />);
  const root = screen.getByTestId('root-header-DailyTab');
  const title = screen.getByTestId('root-header-title-DailyTab');
  const icon = screen.getByTestId('root-header-icon-DailyTab');
  expect(StyleSheet.flatten(root.props.style)).toMatchObject({ minHeight });
  expect(StyleSheet.flatten(root.props.style)).not.toHaveProperty('height');
  expect(title.props.children).toBe('데일리');
  expect(title.props.numberOfLines).toBe(1);
  expect(title.props.ellipsizeMode).toBe('tail');
  expect(title.props.maxFontSizeMultiplier).toBe(2);
  expect(icon.props.name).toBe(ROOT_SECTION_CONFIG.DailyTab.icon);
  expect(icon.props.size).toBe(20);
  expect(icon.props.maxFontSizeMultiplier).toBe(2);
});

test('6 route title에는 emoji가 없고 override는 사용자 콘텐츠를 그대로 보존한다', () => {
  for (const config of Object.values(ROOT_SECTION_CONFIG)) {
    expect(config.title).not.toMatch(/[📅⭐📁📰💬⚙️]/u);
  }
  const screen = render(<RootSectionHeaderTitle section="ProjectTab" title="긴 사용자 프로젝트 제목" />);
  expect(screen.getByTestId('root-header-title-ProjectTab').props.children)
    .toBe('긴 사용자 프로젝트 제목');
});
