jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render, within } from '@testing-library/react-native';
import { CompletedCardFilters } from '../CompletedCardFilters';
import { CompletedCardCollection } from '../CompletedCardCollection';
import { GlassButton } from '../../GlassSurface';
import type { CompletedBrowser } from '../../../hooks/useCompletedCards';

const browser = (overrides: Partial<CompletedBrowser>) => ({
  period: '7', setPeriod: jest.fn(), start: '2026-10-01', setStart: jest.fn(), end: '2026-10-02', setEnd: jest.fn(),
  search: '', setSearch: jest.fn(), error: null, invalidRange: false, loading: false, retry: jest.fn(), ...overrides,
}) as unknown as CompletedBrowser;

test('a read failure keeps the hook message and offers the board retry button', () => {
  const retry = jest.fn();
  const screen = render(<CompletedCardFilters browser={browser({ error: '공개 예시: 완료 카드를 불러오지 못했습니다.', retry })} />);
  expect(screen.getByTestId('completed-error').props.accessibilityRole).toBe('alert');
  expect(screen.getByText('공개 예시: 완료 카드를 불러오지 못했습니다.')).toBeTruthy();
  const button = screen.UNSAFE_getByType(GlassButton);
  expect(button.props.accessibilityLabel).toBe('완료 카드 다시 조회');
  expect(button.props.style).toMatchObject({ alignSelf: 'flex-start' });
  expect(within(screen.getByLabelText('완료 카드 다시 조회')).UNSAFE_getByType(Text).props.children).toBe('다시 시도');
  fireEvent.press(screen.getByLabelText('완료 카드 다시 조회'));
  expect(retry).toHaveBeenCalledTimes(1);
});

test('while the retry read runs the button stays in place but is disabled', () => {
  const retry = jest.fn();
  const screen = render(<CompletedCardFilters browser={browser({ error: '조회 실패', loading: true, retry })} />);
  const button = screen.getByLabelText('완료 카드 다시 조회');
  expect(button.props.accessibilityState).toMatchObject({ disabled: true });
  fireEvent.press(button);
  expect(retry).not.toHaveBeenCalled();
});

test('a range notice has no retry button because a new read cannot fix it', () => {
  const screen = render(<CompletedCardFilters browser={browser({ period: 'custom', error: '시작일과 종료일을 확인해 주세요.', invalidRange: true })} />);
  expect(screen.getByText('시작일과 종료일을 확인해 주세요.')).toBeTruthy();
  expect(screen.getByLabelText('완료 시작일')).toBeTruthy();
  expect(screen.queryByLabelText('완료 카드 다시 조회')).toBeNull();
});

test('without an error there is neither a notice nor a retry button', () => {
  const screen = render(<CompletedCardFilters browser={browser({})} />);
  expect(screen.queryByTestId('completed-error')).toBeNull();
  expect(screen.queryByLabelText('완료 카드 다시 조회')).toBeNull();
});

test('the folder completed collection shows the failure instead of the empty notice', () => {
  const failed = render(<CompletedCardCollection api={null} browser={browser({ cards: [], error: '조회 실패', resetKey: 'k', loadMore: jest.fn() })} onOpen={jest.fn()} />);
  expect(failed.getByLabelText('완료 카드 다시 조회')).toBeTruthy();
  expect(failed.queryByText('선택한 기간에 완료 카드가 없습니다')).toBeNull();
  failed.unmount();
  const empty = render(<CompletedCardCollection api={null} browser={browser({ cards: [], resetKey: 'k', loadMore: jest.fn() })} onOpen={jest.fn()} />);
  expect(empty.getByText('선택한 기간에 완료 카드가 없습니다')).toBeTruthy();
});
