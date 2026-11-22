import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AttachmentPreviewModal } from '../../components/AttachmentPreviewModal';
import { reviewWorkspace } from '../../component-review/ReviewSessionFiles';
import { SessionFilesContent, SessionFilesView } from '../SessionFilesScreen';

const mockGet = jest.fn();
const mockRead = jest.fn();
let mockStreamOptions: { onEvent: () => void } | undefined;
jest.mock('../../api/client', () => ({ createApiClient: () => ({ getSessionWorkspace: mockGet, readSessionWorkspaceText: mockRead, sessionEventsUrl: () => '' }) }));
jest.mock('../../hooks/useSSEStream', () => ({ useSSEStream: (options: { onEvent: () => void }) => { mockStreamOptions = options; } }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../components/AttachmentPreviewModal', () => ({ AttachmentPreviewModal: () => null }));

beforeEach(() => { mockGet.mockReset(); mockRead.mockReset(); });

function view(overrides: Partial<React.ComponentProps<typeof SessionFilesView>> = {}) {
  const props: React.ComponentProps<typeof SessionFilesView> = { data: reviewWorkspace, error: false, refreshing: false,
    onRefresh: jest.fn(), expanded: false, onToggle: jest.fn(), selected: null, onSelect: jest.fn(), sessionId: 's/1', ...overrides };
  return { ...render(<SessionFilesView {...props} />), props };
}

test('활동별 행, 새 파일과 줄 수를 보이고 읽기 전용은 접힌다', () => {
  const screen = view();
  expect(screen.getByText('새')).toBeTruthy();
  expect(screen.getByText('+42')).toBeTruthy();
  expect(screen.getByText(' −18')).toBeTruthy();
  expect(screen.queryByLabelText('dispatcher.ts')).toBeNull();
  const icons = screen.UNSAFE_getAllByType('Ionicons' as any).map(icon => icon.props.name);
  expect(icons).toEqual(expect.arrayContaining(['pencil-outline', 'git-commit-outline', 'document-outline', 'eye-outline']));
  fireEvent.press(screen.getByLabelText('읽기만 한 파일'));
  expect(screen.props.onToggle).toHaveBeenCalled();
});

test('행을 누르면 원문 주소를 가진 순서 목록을 미리보기에 넘기고 크기 미상의 읽은 파일도 연다', () => {
  const screen = view({ expanded: true, selected: 'soul-server-ts/src/upstream/dispatcher.ts' });
  fireEvent.press(screen.getByLabelText('outbox_retry.ts'));
  expect(screen.props.onSelect).toHaveBeenCalledWith('soul-server-ts/src/upstream/outbox_retry.ts');
  const modal = screen.UNSAFE_getByType(AttachmentPreviewModal);
  expect(modal.props.item.byteSize).toBeNull();
  expect(modal.props.item.source.originalUrl).toBe('/api/sessions/s%2F1/workspace/file?path=soul-server-ts%2Fsrc%2Fupstream%2Fdispatcher.ts&download=true');
  modal.props.item.loadText(new AbortController().signal);
  expect(mockRead).toHaveBeenCalledWith('s/1', 'soul-server-ts/src/upstream/dispatcher.ts', expect.anything());
});

test.each([
  ['offline', { ...reviewWorkspace, node: { id: 'node', status: 'offline' as const } }, '노드 끊김'],
  ['not_git', { ...reviewWorkspace, snapshot: { ...reviewWorkspace.snapshot!, state: 'not_git' as const } }, 'Git 작업 폴더가 아닙니다'],
  ['unsupported', { ...reviewWorkspace, node: { id: 'node', status: 'unsupported' as const } }, '이 노드는 파일 보기를 지원하지 않습니다'],
  ['no_workspace', { ...reviewWorkspace, node: { id: 'node', status: 'no_workspace' as const } }, '작업 폴더가 없습니다'],
])('%s 상태를 표시한다', (_label, data, text) => { expect(view({ data }).getByText(new RegExp(text))).toBeTruthy(); });

test('실패 안내의 다시 시도가 조회를 요청한다', () => {
  const screen = view({ data: null, error: true });
  fireEvent.press(screen.getByText('다시 시도'));
  expect(screen.props.onRefresh).toHaveBeenCalled();
});

test('pending을 3초마다 열 번 다시 읽고 떠나면 타이머를 멈춘다', async () => {
  jest.useFakeTimers();
  mockGet.mockResolvedValue({ ...reviewWorkspace, files: [], read_only: [], snapshot: { ...reviewWorkspace.snapshot!, state: 'pending' } });
  const screen = render(<SessionFilesContent sessionId="s" active />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  for (let i = 0; i < 10; i++) await act(async () => { jest.advanceTimersByTime(3000); await Promise.resolve(); await Promise.resolve(); });
  expect(mockGet).toHaveBeenCalledTimes(11);
  await act(async () => { jest.advanceTimersByTime(30000); });
  expect(mockGet).toHaveBeenCalledTimes(11);
  screen.unmount();
  jest.useRealTimers();
});

test('요청 실패 후 다시 시도하면 결과가 나온다', async () => {
  mockGet.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reviewWorkspace);
  const onHeader = jest.fn();
  const screen = render(<SessionFilesContent sessionId="s" active onHeader={onHeader} />);
  await waitFor(() => expect(screen.getByText('다시 시도')).toBeTruthy());
  expect(onHeader).toHaveBeenLastCalledWith(expect.objectContaining({ title: '파일', branch: false }));
  fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(screen.getByLabelText('config.ts')).toBeTruthy());
  expect(onHeader).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'card1802-outbox-backoff', branch: true }));
});

test('열린 동안 턴이 끝나면 다시 조회하고 떠나면 대기 중인 재조회를 취소한다', async () => {
  jest.useFakeTimers();
  mockGet.mockResolvedValue({ ...reviewWorkspace, snapshot: { ...reviewWorkspace.snapshot!, state: 'pending' } });
  const screen = render(<SessionFilesContent sessionId="s" active />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { mockStreamOptions?.onEvent(); await Promise.resolve(); await Promise.resolve(); });
  expect(mockGet).toHaveBeenCalledTimes(2);
  screen.rerender(<SessionFilesContent sessionId="s" active={false} />);
  await act(async () => { jest.advanceTimersByTime(30000); });
  expect(mockGet).toHaveBeenCalledTimes(2);
  screen.unmount();
  jest.useRealTimers();
});
