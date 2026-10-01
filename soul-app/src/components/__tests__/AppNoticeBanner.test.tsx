import React from 'react';
import { StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppNoticeBanner } from '../AppNoticeBanner';
import { useAppNoticeStore } from '../../store/appNoticeStore';

beforeEach(() => {
  jest.useFakeTimers();
  useAppNoticeStore.setState({ notice: null });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

test('앱 상단에 비차단 알림을 표시하고 일정 시간 뒤 닫는다', () => {
  const screen = render(<AppNoticeBanner autoDismissMs={3000} />);

  act(() => {
    useAppNoticeStore.getState().showNotice({
      title: '검수 확인',
      message: '확인 처리했습니다.',
      tone: 'success',
    });
  });

  expect(screen.getByText('검수 확인')).toBeTruthy();
  expect(screen.getByText('확인 처리했습니다.')).toBeTruthy();
  expect(screen.getByTestId('app-notice-banner').props.accessibilityRole).toBe('alert');
  expect(
    StyleSheet.flatten(screen.getByTestId('app-notice-viewport').props.style),
  ).toMatchObject({
    position: 'absolute',
    alignItems: 'center',
  });

  act(() => {
    jest.advanceTimersByTime(3000);
  });
  expect(screen.queryByTestId('app-notice-banner')).toBeNull();
});

test('새 알림은 이전 자동 닫기 타이머에 의해 사라지지 않는다', () => {
  const screen = render(<AppNoticeBanner autoDismissMs={3000} />);

  act(() => {
    useAppNoticeStore.getState().showNotice({
      title: '첫 알림',
      message: '첫 메시지',
      tone: 'success',
    });
  });
  act(() => {
    jest.advanceTimersByTime(2000);
  });
  act(() => {
    useAppNoticeStore.getState().showNotice({
      title: '두 번째 알림',
      message: '두 번째 메시지',
      tone: 'error',
    });
  });
  act(() => {
    jest.advanceTimersByTime(1500);
  });

  expect(screen.getByText('두 번째 알림')).toBeTruthy();
  expect(screen.getByText('두 번째 메시지')).toBeTruthy();
});

test('앱 루트가 배너 host를 정확히 한 번 마운트한다', () => {
  const appSource = readFileSync(join(__dirname, '../../../App.tsx'), 'utf8');
  expect(appSource.match(/<AppNoticeBanner\s*\/>/g)).toHaveLength(1);
});
