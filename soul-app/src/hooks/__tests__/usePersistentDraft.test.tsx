import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useDraftStore } from '../../store/draftStore';
import { usePersistentDraft } from '../usePersistentDraft';

const jwt = (email: string, exp = 9999999999) => `header.${Buffer.from(JSON.stringify({ email, sub: email, exp })).toString('base64url')}.signature`;
beforeEach(async () => {
  await useAuthStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: jwt('one@example.com') });
  useSettingsStore.setState({ serverUrl: 'https://one.example' });
  useDraftStore.setState({ drafts: {} });
});

test('app restart restores edited draft and token refresh keeps the stable user key', async () => {
  const first = renderHook(() => usePersistentDraft('card-comment', ['card-1'], ''));
  act(() => first.result.current.setValue('작성 중'));
  await new Promise(resolve => setTimeout(resolve, 0));
  const saved = await AsyncStorage.getItem('soul-app-drafts');
  first.unmount();
  useDraftStore.setState({ drafts: {} });
  await AsyncStorage.setItem('soul-app-drafts', saved!);
  await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: jwt('one@example.com', 9999999998) });
  const next = renderHook(() => usePersistentDraft('card-comment', ['card-1'], ''));
  expect(next.result.current.value).toBe('작성 중');
  expect(saved).not.toContain('signature');
  expect(saved).not.toContain('auth-scope');
});

test('server, user, role and target isolate drafts; form drafts preserve all fields', () => {
  const view = renderHook(({ target }: { target: string }) => usePersistentDraft('card-create', [target], { title: '', request: '' }), { initialProps: { target: 'all' } });
  act(() => view.result.current.setValue({ title: '제목', request: '요청' }));
  view.rerender({ target: 'folder' });
  expect(view.result.current.value.title).toBe('');
  view.rerender({ target: 'all' });
  expect(view.result.current.value.request).toBe('요청');
  act(() => { useSettingsStore.setState({ serverUrl: 'https://two.example' }); });
  expect(view.result.current.value.title).toBe('');
  act(() => { useSettingsStore.setState({ serverUrl: 'https://one.example' }); });
  act(() => { useAuthStore.setState({ jwt: jwt('two@example.com') }); });
  expect(view.result.current.value.title).toBe('');
  act(() => { useAuthStore.setState({ jwt: jwt('one@example.com') }); });
  expect(view.result.current.value.title).toBe('제목');
  const other = renderHook(() => usePersistentDraft('card-comment', ['all'], ''));
  expect(other.result.current.value).toBe('');
});

test('successful submitted value clears only its own unchanged draft; failure and close keep it', () => {
  const first = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  act(() => first.result.current.setValue('전송 원문'));
  const confirmed = first.result.current.clearIfMatches;
  act(() => first.result.current.setValue('다음 메시지'));
  act(() => confirmed('전송 원문'));
  expect(first.result.current.value).toBe('다음 메시지');
  first.unmount();
  const reopened = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  expect(reopened.result.current.value).toBe('다음 메시지');
  act(() => reopened.result.current.clearIfMatches('다음 메시지'));
  expect(reopened.result.current.hasDraft).toBe(false);
});

test('hydration gate prevents empty defaults from replacing a saved draft', async () => {
  const key = JSON.stringify(['https://one.example', 'one@example.com', 'chat', ['node', 'session']]);
  await AsyncStorage.setItem('soul-app-drafts', JSON.stringify({ state: { drafts: { [key]: '복원할 원문' } }, version: 0 }));
  let resolveRead!: (value: string | null) => void;
  const stored = await AsyncStorage.getItem('soul-app-drafts');
  const read = jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
  let hydration!: Promise<void>;
  act(() => { hydration = useDraftStore.persist.rehydrate() as Promise<void>; });
  const view = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  expect(view.result.current.ready).toBe(false);
  act(() => view.result.current.setValue(''));
  await act(async () => { resolveRead(stored); await hydration; });
  expect(view.result.current.value).toBe('복원할 원문');
  read.mockRestore();
});

test('unidentified user does not load or persist drafts; connection settings have a local scope', () => {
  useAuthStore.setState({ jwt: null });
  const view = renderHook(() => usePersistentDraft('chat', ['node', 'session'], ''));
  act(() => view.result.current.setValue('메모리 입력'));
  expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(0);
  const connection = renderHook(() => usePersistentDraft('connection-settings', [], { url: '', type: 'soul-server' }, { deviceLocal: true }));
  act(() => connection.result.current.setValue({ url: 'https://new.example', type: 'orchestrator' }));
  expect(Object.keys(useDraftStore.getState().drafts)).toHaveLength(1);
});

test('clearing server text is a real edit; discarding restores the server value', () => {
  const view = renderHook(() => usePersistentDraft('project-context', ['project'], '서버 지침'));
  act(() => view.result.current.setValue(''));
  expect(view.result.current.value).toBe('');
  expect(view.result.current.hasDraft).toBe(true);
  act(() => view.result.current.clear());
  expect(view.result.current.value).toBe('서버 지침');
});
