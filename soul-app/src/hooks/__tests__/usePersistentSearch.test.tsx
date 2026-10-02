import { act, renderHook } from '@testing-library/react-native';
import { usePersistentSearch } from '../usePersistentSearch';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useDraftStore } from '../../store/draftStore';
import { useSearchStore } from '../../store/searchStore';

beforeEach(async () => {
  await useAuthStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useSettingsStore.setState({ serverUrl: 'https://search.example' });
  useAuthStore.setState({ jwt: `header.${Buffer.from(JSON.stringify({ email: 'search@example.com' })).toString('base64url')}.signature` });
  useDraftStore.setState({ drafts: {} });
  useSearchStore.setState({ query: '' });
});

test('search runtime owner restores after close and remount; explicit empty text removes draft', () => {
  const host = renderHook(() => usePersistentSearch());
  act(() => { useSearchStore.getState().setQuery('입력 보존'); });
  act(() => { useSearchStore.getState().closeTabletSearch(); });
  expect(useSearchStore.getState().query).toBe('입력 보존');
  host.unmount();
  useSearchStore.setState({ query: '' });
  renderHook(() => usePersistentSearch());
  expect(useSearchStore.getState().query).toBe('입력 보존');
  act(() => { useSearchStore.getState().setQuery(''); });
  expect(useDraftStore.getState().drafts).toEqual({});
});
