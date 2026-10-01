import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

import { TurnSummaryCaption } from '../TurnSummaryCaption';

test.each([
  ['compact', { width: 390, height: 844, scale: 3, fontScale: 1 }],
  ['iPad split pane', { width: 512, height: 1366, scale: 2, fontScale: 1 }],
] as const)('%s에서 에이전트 말풍선 쪽의 작은 좌측 캡션을 렌더한다', (
  _label,
  dimensions,
) => {
  mockDimensions = dimensions;
  const screen = render(
    <TurnSummaryCaption content={'첫 줄 요약\n둘째 줄 요약'} />,
  );

  expect(screen.getByTestId('turn-summary-caption-text').props.children).toBe(
    '첫 줄 요약\n둘째 줄 요약',
  );
  expect(
    StyleSheet.flatten(screen.getByTestId('turn-summary-caption').props.style),
  ).toMatchObject({
    alignItems: 'flex-start',
  });
  const bubbleStyle = StyleSheet.flatten(
    screen.getByTestId('turn-summary-caption-bubble').props.style,
  );
  expect(bubbleStyle).toMatchObject({
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  });
  expect(bubbleStyle.backgroundColor).toBeTruthy();
  expect(
    StyleSheet.flatten(
      screen.getByTestId('turn-summary-caption-text').props.style,
    ),
  ).toMatchObject({
    textAlign: 'left',
  });
  expect(
    StyleSheet.flatten(screen.getByTestId('turn-summary-caption').props.style),
  ).not.toMatchObject({
    width: expect.anything(),
    maxWidth: expect.anything(),
  });
});
