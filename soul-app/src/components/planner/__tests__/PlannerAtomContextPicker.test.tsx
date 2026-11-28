import { act, fireEvent, render } from '@testing-library/react-native';
import { PlannerAtomContextPicker } from '../PlannerAtomContextPicker';
const settleTimers = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });

test('노드 고르기, 깊이 1~5 세그먼트, 제목만 스위치로 정해 한 번에 반환한다', async () => {
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
  expect(screen.getByText('참고 자료 추가')).toBeTruthy();
  expect(['1', '2', '3', '4', '5'].map((value) => screen.getByTestId(`settings-segment-atom-picker-depth-${value}`))).toHaveLength(5);
  fireEvent.press(screen.getByTestId('settings-segment-atom-picker-depth-5'));
  fireEvent(screen.getByTestId('atom-picker-titles-only'), 'valueChange', true);
  fireEvent.press(screen.getByTestId('atom-picker-add-selected'));

  expect(onPicked).toHaveBeenCalledWith({
    instance: 'atom',
    nodeId: 'node-a',
    nodeTitle: '노드 A',
    depth: 5,
    titlesOnly: true,
  });
  await settleTimers();
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
  await settleTimers();
});

test('확인 연타는 부모 반영과 닫기를 한 번만 실행한다', async () => {
  const onPicked = jest.fn(); const onClose = jest.fn();
  const api = { listAtomRootNodes: jest.fn().mockResolvedValue([{ id: 'a', title: 'A' }]), listAtomNodeChildren: jest.fn() };
  const screen = render(<PlannerAtomContextPicker visible api={api} onClose={onClose} onPicked={onPicked} />);
  await act(async () => {});
  fireEvent.press(screen.getByTestId('atom-picker-select-a'));
  const confirm = screen.getByTestId('atom-picker-add-selected');
  act(() => { fireEvent.press(confirm); fireEvent.press(confirm); });
  expect(onPicked).toHaveBeenCalledTimes(1); expect(onClose).toHaveBeenCalledTimes(1); await settleTimers();
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

test('기존 참고 자료를 고칠 때는 그 값으로 열리고 저장으로 돌려준다', async () => {
  const onPicked = jest.fn();
  const api = { listAtomRootNodes: jest.fn().mockResolvedValue([{ id: 'other', title: '다른 노드' }]), listAtomNodeChildren: jest.fn() };
  const screen = render(<PlannerAtomContextPicker visible api={api} onClose={jest.fn()} onPicked={onPicked}
    initial={{ instance: 'atom-nl', nodeId: 'kept', nodeTitle: '유지할 노드', depth: 2, titlesOnly: true }} />);
  await act(async () => {});
  expect(screen.getByText('참고 자료 고치기')).toBeTruthy();
  expect(screen.getByTestId('atom-picker-selected-kept')).toBeTruthy();
  expect(screen.getByTestId('settings-segment-atom-picker-depth-2').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
  fireEvent.press(screen.getByTestId('settings-segment-atom-picker-depth-4'));
  fireEvent.press(screen.getByText('저장'));
  expect(onPicked).toHaveBeenCalledWith({ instance: 'atom-nl', nodeId: 'kept', nodeTitle: '유지할 노드', depth: 4, titlesOnly: true });
  await settleTimers();
});
