import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ActivityIndicator, RefreshControl } from 'react-native';
import { AttachmentPreviewModal } from '../../components/AttachmentPreviewModal';
import { reviewWorkspace } from '../../component-review/ReviewSessionFiles';
import { RefreshButton, SessionFilesContent, SessionFilesView } from '../SessionFilesScreen';

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

test('git 수치가 없는 쓴 파일에는 세션 기록 기준 줄 수를 같은 모양으로 보이고, 없으면 비운다', () => {
  const screen = view();
  expect(screen.getByLabelText('세션 기록 기준 추가 142줄, 삭제 27줄')).toBeTruthy();
  expect(screen.getByText('+142')).toBeTruthy();
  expect(screen.getByText(' −27')).toBeTruthy();
  expect(screen.getAllByLabelText(/세션 기록 기준/)).toHaveLength(1);
  expect(screen.getByText('+42')).toBeTruthy();
  const files = reviewWorkspace.files.map(file => ({ ...file, session_added: null, session_deleted: null }));
  const empty = view({ data: { ...reviewWorkspace, files } });
  expect(empty.queryByText('+142')).toBeNull();
  expect(empty.queryByLabelText(/세션 기록 기준/)).toBeNull();
});

test('행을 누르면 원문 주소를 가진 순서 목록을 미리보기에 넘기고 크기 미상의 읽은 파일도 연다', () => {
  const screen = view({ expanded: true, selected: 'soul-server-ts/src/upstream/dispatcher.ts' });
  fireEvent.press(screen.getByLabelText('outbox_retry.ts'));
  expect(screen.props.onSelect).toHaveBeenCalledWith('soul-server-ts/src/upstream/outbox_retry.ts');
  const modal = screen.UNSAFE_getByType(AttachmentPreviewModal);
  expect(modal.props.item.pdfCache).toBe('none');
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
  expect(screen.getByText('파일을 불러오지 못했습니다').props.selectable).toBe(false);
  fireEvent.press(screen.getByText('다시 시도'));
  expect(screen.props.onRefresh).toHaveBeenCalled();
});

test('파일 없는 not_git은 상태만 중앙에 두고 읽은 파일이 있으면 목록과 함께 표시한다', () => {
  const data = { ...reviewWorkspace, files: [], read_only: [], snapshot: { ...reviewWorkspace.snapshot!, state: 'not_git' as const } };
  const empty = view({ data });
  expect(empty.getByText('Git 작업 폴더가 아닙니다').props.selectable).toBe(false);
  expect(empty.getByTestId('session-files-state').props.style).toEqual(expect.objectContaining({ flex: 1, justifyContent: 'center' }));
  empty.unmount();
  const withReads = view({ data: { ...data, read_only: reviewWorkspace.read_only } });
  expect(withReads.getByLabelText('읽기만 한 파일')).toBeTruthy();
  expect(withReads.getByTestId('session-files-state').props.style.flex).toBeUndefined();
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

test('첫 조회에는 본문 스피너 하나만 보이고 머리 다시 읽기가 잠긴다', async () => {
  mockGet.mockReturnValue(new Promise(() => {}));
  let header: React.ComponentProps<typeof RefreshButton>['header'] = null;
  const screen = render(<SessionFilesContent sessionId="s" active onHeader={value => { header = value; }} />);
  await waitFor(() => expect(header).not.toBeNull());
  const button = render(<RefreshButton header={header} />);
  expect(screen.UNSAFE_getAllByType(ActivityIndicator)).toHaveLength(1);
  expect(button.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
  expect(button.getByLabelText('다시 읽기').props.accessibilityState.disabled).toBe(true);
});

test('pending 응답도 본문 스피너 하나를 유지하고 머리 버튼은 잠긴다', async () => {
  mockGet.mockResolvedValue({ ...reviewWorkspace, snapshot: { ...reviewWorkspace.snapshot!, state: 'pending', refreshing: true } });
  let header: React.ComponentProps<typeof RefreshButton>['header'] = null;
  const screen = render(<SessionFilesContent sessionId="s" active onHeader={value => { header = value; }} />);
  await waitFor(() => expect(header?.disabled).toBe(true));
  const button = render(<RefreshButton header={header} />);
  expect(screen.UNSAFE_getAllByType(ActivityIndicator)).toHaveLength(1);
  expect(button.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
  expect(button.getByLabelText('다시 읽기').props.accessibilityState.disabled).toBe(true);
});

test('다시 읽는 중 중복 누름은 새 요청을 만들지 않고 당김 표시도 켜지 않는다', async () => {
  let resolveRefresh!: (value: typeof reviewWorkspace) => void;
  mockGet.mockResolvedValueOnce(reviewWorkspace).mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }));
  let header: React.ComponentProps<typeof RefreshButton>['header'] = null;
  const screen = render(<SessionFilesContent sessionId="s" active onHeader={value => { header = value; }} />);
  await waitFor(() => expect(screen.getByLabelText('config.ts')).toBeTruthy());
  act(() => { header!.refresh(); header!.refresh(); });
  expect(mockGet).toHaveBeenCalledTimes(2);
  const button = render(<RefreshButton header={header} />);
  expect(button.UNSAFE_getAllByType(ActivityIndicator)).toHaveLength(1);
  expect(button.getByLabelText('다시 읽기').props.accessibilityState.disabled).toBe(true);
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  await act(async () => { resolveRefresh(reviewWorkspace); await Promise.resolve(); });
});

test('서버 자동 갱신 중에는 당김 새로고침 표시가 꺼져 있다', async () => {
  jest.useFakeTimers();
  mockGet.mockResolvedValueOnce({ ...reviewWorkspace, snapshot: { ...reviewWorkspace.snapshot!, refreshing: true } })
    .mockReturnValueOnce(new Promise(() => {}));
  const screen = render(<SessionFilesContent sessionId="s" active />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { jest.advanceTimersByTime(3000); await Promise.resolve(); });
  expect(mockGet).toHaveBeenCalledTimes(2);
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  screen.unmount();
  jest.useRealTimers();
});

test('사용자가 당겨 새로고칠 때만 당김 표시를 켠다', async () => {
  let finish!: (value: typeof reviewWorkspace) => void;
  mockGet.mockResolvedValueOnce(reviewWorkspace).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const screen = render(<SessionFilesContent sessionId="s" active />);
  await waitFor(() => expect(screen.getByLabelText('config.ts')).toBeTruthy());
  act(() => { screen.UNSAFE_getByType(RefreshControl).props.onRefresh(); });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);
  await act(async () => { finish(reviewWorkspace); await Promise.resolve(); });
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
});

test('턴 종료로 자동 갱신할 때는 당김 표시를 켜지 않는다', async () => {
  let finish!: (value: typeof reviewWorkspace) => void;
  mockGet.mockResolvedValueOnce(reviewWorkspace).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const screen = render(<SessionFilesContent sessionId="s" active />);
  await waitFor(() => expect(screen.getByLabelText('config.ts')).toBeTruthy());
  act(() => { mockStreamOptions?.onEvent(); });
  expect(mockGet).toHaveBeenCalledTimes(2);
  expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  await act(async () => { finish(reviewWorkspace); await Promise.resolve(); });
});
