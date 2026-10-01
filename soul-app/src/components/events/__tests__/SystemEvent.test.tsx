import React from 'react';
import { StyleSheet, View } from 'react-native';
import { render } from '@testing-library/react-native';
import type { SessionEvent } from '../../../api/types';
import { PHONE_CHAT_TYPOGRAPHY, TABLET_CHAT_TYPOGRAPHY, DESIGN_SPACING, TABLET_SPACING } from '../../../theme';
import { SystemEvent } from '../SystemEvent';

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

test.each([
  ['좁은 화면', 390, PHONE_CHAT_TYPOGRAPHY, DESIGN_SPACING],
  ['넓은 화면', 1024, TABLET_CHAT_TYPOGRAPHY, TABLET_SPACING],
] as const)('%s에서 완료·긴 오류·하위 보고를 기존 토큰과 왼쪽 정렬로 렌더한다', (
  _label, width, typography, spacing,
) => {
  mockDimensions = { ...mockDimensions, width };
  const cases: Array<[SessionEvent, string]> = [
    [{ id: '1', type: 'complete', data: { result: '이미 표시된 최종 답변' } }, '턴 완료'],
    [{ id: '2', type: 'error', data: { message: '응답 연결이 끊겼습니다.\n현재 작업의 오류 내용을 확인해주세요.' } },
      '오류: 응답 연결이 끊겼습니다.\n현재 작업의 오류 내용을 확인해주세요.'],
    [{ id: '3', type: 'session_notification', data: { text: '하위 세션의 조사 결과입니다.\n확인한 내용과 남은 작업을 전달합니다.' } },
      '완료 알림: 하위 세션의 조사 결과입니다.\n확인한 내용과 남은 작업을 전달합니다.'],
  ];
  for (const [event, content] of cases) {
    const screen = render(<SystemEvent event={event} />);
    expect(StyleSheet.flatten(screen.UNSAFE_getByType(View).props.style)).toMatchObject({
      alignItems: 'flex-start',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.lg,
    });
    const text = screen.getByText(`— ${content} —`);
    expect(StyleSheet.flatten(text.props.style)).toMatchObject({
      textAlign: 'left', fontSize: typography.meta, fontStyle: 'italic',
    });
    expect(StyleSheet.flatten(text.props.style).color).toBeTruthy();
    screen.unmount();
  }
});
