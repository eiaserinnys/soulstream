import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { PlannerAtomContextPicker } from '../PlannerAtomContextPicker';

test('노드 선택 화면 안에서 depth와 titlesOnly를 정해 한 번에 반환한다', async () => {
  const onPicked = jest.fn();
  const api = {
    listAtomRootNodes: jest.fn().mockResolvedValue({
      children: [{ id: 'node-a', title: '노드 A' }],
    }),
    listAtomNodeChildren: jest.fn(),
  };
  const screen = render(
    <PlannerAtomContextPicker
      visible
      api={api}
      onClose={jest.fn()}
      onPicked={onPicked}
    />,
  );

  await act(async () => { await Promise.resolve(); });
  fireEvent.press(screen.getByTestId('atom-picker-select-node-a'));
  expect(screen.getByTestId('atom-picker-selected-node-a')).toBeTruthy();
  fireEvent.press(screen.getByTestId('atom-picker-depth-5'));
  fireEvent(screen.getByTestId('atom-picker-titles-only'), 'valueChange', true);
  fireEvent.press(screen.getByTestId('atom-picker-add-selected'));

  expect(onPicked).toHaveBeenCalledWith({
    instance: 'atom',
    nodeId: 'node-a',
    nodeTitle: '노드 A',
    depth: 5,
    titlesOnly: true,
  });
});

test('노드 행은 드릴다운하고 현재 노드도 같은 옵션으로 선택할 수 있다', async () => {
  const onPicked = jest.fn();
  const api = {
    listAtomRootNodes: jest.fn().mockResolvedValue({ children: [{ id: 'parent', title: '부모' }] }),
    listAtomNodeChildren: jest.fn().mockResolvedValue({ children: [{ id: 'child', title: '자식' }] }),
  };
  const screen = render(
    <PlannerAtomContextPicker visible api={api} onClose={jest.fn()} onPicked={onPicked} />,
  );

  await act(async () => { await Promise.resolve(); });
  fireEvent.press(screen.getByTestId('atom-picker-drill-parent'));
  await act(async () => { await Promise.resolve(); });
  expect(api.listAtomNodeChildren).toHaveBeenCalledWith('parent');
  fireEvent.press(screen.getByTestId('atom-picker-select-current'));
  fireEvent.press(screen.getByTestId('atom-picker-add-selected'));

  expect(onPicked).toHaveBeenCalledWith(expect.objectContaining({
    nodeId: 'parent',
    nodeTitle: '부모',
    depth: 3,
    titlesOnly: false,
  }));
});
