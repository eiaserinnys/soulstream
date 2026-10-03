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

test('확인 연타는 부모 반영과 닫기를 한 번만 실행한다', async () => {
  const onPicked = jest.fn(); const onClose = jest.fn();
  const api = { listAtomRootNodes: jest.fn().mockResolvedValue([{ id: 'a', title: 'A' }]), listAtomNodeChildren: jest.fn() };
  const screen = render(<PlannerAtomContextPicker visible api={api} onClose={onClose} onPicked={onPicked} />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('atom-picker-select-a'));
  const confirm = screen.getByTestId('atom-picker-add-selected');
  act(() => { fireEvent.press(confirm); fireEvent.press(confirm); });
  expect(onPicked).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1);
});

test('탐색 중이거나 조회 실패면 이전 선택을 확인할 수 없다', async () => {
  const onPicked = jest.fn(); let reject!: (error: Error) => void;
  const api = { listAtomRootNodes: jest.fn().mockResolvedValue([{ id: 'a', title: 'A' }]),
    listAtomNodeChildren: jest.fn(() => new Promise((_, no) => { reject = no; })) };
  const screen = render(<PlannerAtomContextPicker visible api={api} onClose={jest.fn()} onPicked={onPicked} />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('atom-picker-select-a'));
  fireEvent.press(screen.getByTestId('atom-picker-drill-a'));
  fireEvent.press(screen.getByTestId('atom-picker-add-selected'));
  expect(onPicked).not.toHaveBeenCalled();
  await act(async () => reject(new Error('조회 실패')));
  fireEvent.press(screen.getByTestId('atom-picker-add-selected'));
  expect(onPicked).not.toHaveBeenCalled();
});
