jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');

import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { FolderWorkspaceToggleActions } from '../FolderWorkspaceToggleActions';

const noop = async () => undefined;

test('중요·오늘 상태를 label·icon·selected와 원형 hit target으로 구분한다', () => {
  const onOpenMenu = jest.fn();
  const screen = render(
    <FolderWorkspaceToggleActions
      starred
      inToday={false}
      onOpenMenu={onOpenMenu}
      onToggleStarred={noop}
      onToggleToday={noop}
      onError={jest.fn()}
    />,
  );

  const starred = screen.getByTestId('task-workspace-starred-toggle');
  const today = screen.getByTestId('task-workspace-today-toggle');
  const menu = screen.getByTestId('folder-workspace-menu');
  expect(starred.props.accessibilityLabel).toBe('중요 폴더 지정 해제');
  expect(starred.props.accessibilityState).toMatchObject({ selected: true, disabled: false });
  expect(screen.getByTestId('task-workspace-starred-icon').props.name).toBe('star');
  expect(today.props.accessibilityLabel).toBe('오늘 데일리에 추가');
  expect(today.props.accessibilityState).toMatchObject({ selected: false, disabled: false });
  expect(screen.getByTestId('task-workspace-today-icon').props.name).toBe('calendar-plus-outline');

  const buttons = [starred, today, menu];
  for (const button of buttons) {
    const style = StyleSheet.flatten(button.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
    expect(style.borderRadius).toBe(style.minWidth / 2);
  }
  const frames = buttons.map((button) => {
    const style = StyleSheet.flatten(button.props.style);
    return [style.width, style.height, style.borderRadius, style.borderWidth];
  });
  expect(frames[1]).toEqual(frames[0]);
  expect(frames[2]).toEqual(frames[0]);
  fireEvent.press(menu);
  expect(onOpenMenu).toHaveBeenCalledTimes(1);
});

test('같은 렌더 프레임의 중요 업무 연속 탭은 mutation을 한 번만 호출한다', async () => {
  let resolve!: () => void;
  const mutation = new Promise<void>((done) => { resolve = done; });
  const onToggleStarred = jest.fn(() => mutation);
  const screen = render(
    <FolderWorkspaceToggleActions
      starred={false}
      inToday={false}
      onToggleStarred={onToggleStarred}
      onToggleToday={noop}
      onError={jest.fn()}
    />,
  );

  fireEvent.press(screen.getByTestId('task-workspace-starred-toggle'));
  fireEvent.press(screen.getByTestId('task-workspace-starred-toggle'));
  expect(onToggleStarred).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('task-workspace-starred-toggle').props.accessibilityState)
    .toMatchObject({ disabled: true });

  await act(async () => resolve());
});

test('오늘 데이터 로딩은 오늘 버튼만 잠그고 중요 업무 버튼은 유지한다', async () => {
  const onToggleStarred = jest.fn(async () => undefined);
  const onToggleToday = jest.fn(async () => undefined);
  const screen = render(
    <FolderWorkspaceToggleActions
      starred={false}
      inToday={false}
      todayDisabled
      todayLoading
      onToggleStarred={onToggleStarred}
      onToggleToday={onToggleToday}
      onError={jest.fn()}
    />,
  );

  expect(screen.getByTestId('task-workspace-starred-toggle').props.accessibilityState)
    .toMatchObject({ disabled: false });
  expect(screen.getByTestId('task-workspace-today-toggle').props.accessibilityState)
    .toMatchObject({ disabled: true, busy: true });

  await act(async () => {
    fireEvent.press(screen.getByTestId('task-workspace-starred-toggle'));
    fireEvent.press(screen.getByTestId('task-workspace-today-toggle'));
  });
  expect(onToggleStarred).toHaveBeenCalledTimes(1);
  expect(onToggleToday).not.toHaveBeenCalled();
});

test('오늘 mutation 실패는 오류를 전달하고 pending을 풀어 재시도한다', async () => {
  const failure = new Error('daily failed');
  const onToggleToday = jest.fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(undefined);
  const onError = jest.fn();
  const screen = render(
    <FolderWorkspaceToggleActions
      starred={false}
      inToday
      onToggleStarred={noop}
      onToggleToday={onToggleToday}
      onError={onError}
    />,
  );

  await act(async () => {
    fireEvent.press(screen.getByTestId('task-workspace-today-toggle'));
  });
  expect(onError).toHaveBeenCalledWith('today', failure);
  expect(screen.getByTestId('task-workspace-today-icon').props.name).toBe('calendar-minus');
  expect(screen.getByTestId('task-workspace-today-toggle').props.accessibilityState)
    .toMatchObject({ selected: true, disabled: false });

  await act(async () => {
    fireEvent.press(screen.getByTestId('task-workspace-today-toggle'));
  });
  expect(onToggleToday).toHaveBeenCalledTimes(2);
});
