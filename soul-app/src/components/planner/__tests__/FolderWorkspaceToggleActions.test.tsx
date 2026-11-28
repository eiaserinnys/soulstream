jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');

import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { FolderWorkspaceToggleActions } from '../FolderWorkspaceToggleActions';

const noop = async () => undefined;

test('중요·오늘 상태를 label·icon·selected와 원형 hit target으로 구분한다', () => {
  const onOpenMenu = jest.fn();
  const screen = render(
    <FolderWorkspaceToggleActions
      starred

      onOpenMenu={onOpenMenu}
      onToggleStarred={noop}

      onError={jest.fn()}
    />,
  );

  const starred = screen.getByTestId('task-workspace-starred-toggle');
  const menu = screen.getByTestId('folder-workspace-menu');
  expect(starred.props.accessibilityLabel).toBe('중요 폴더 지정 해제');
  expect(starred.props.accessibilityState).toMatchObject({ selected: true, disabled: false });
  expect(screen.getByTestId('task-workspace-starred-icon').props.name).toBe('star');

  const buttons = [starred, menu];
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

      onToggleStarred={onToggleStarred}

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
