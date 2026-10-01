import { applySearchKeyboardCommand } from '../searchKeyboardCommands';
import { useSearchStore } from '../searchStore';

beforeEach(() => {
  useSearchStore.getState().reset();
});

test('⌘K, 방향키, Return, Esc가 검색 상태의 단일 경로를 쓴다', () => {
  applySearchKeyboardCommand({ input: 'k', command: true }, 3);
  expect(useSearchStore.getState().tabletActive).toBe(true);
  expect(useSearchStore.getState().focusRequestId).toBe(1);

  applySearchKeyboardCommand({ input: 'ArrowDown', command: false }, 3);
  expect(useSearchStore.getState().selectedResultIndex).toBe(1);
  applySearchKeyboardCommand({ input: 'ArrowUp', command: false }, 3);
  expect(useSearchStore.getState().selectedResultIndex).toBe(0);

  const beforeActivation = useSearchStore.getState().activationRequestId;
  applySearchKeyboardCommand({ input: 'Enter', command: false }, 3);
  expect(useSearchStore.getState().activationRequestId).toBe(beforeActivation + 1);

  useSearchStore.getState().setQuery('alpha');
  applySearchKeyboardCommand({ input: 'Escape', command: false }, 3);
  expect(useSearchStore.getState().query).toBe('');
  applySearchKeyboardCommand({ input: 'Escape', command: false }, 3);
  expect(useSearchStore.getState().tabletActive).toBe(false);
});
