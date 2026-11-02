import { useDisplayPreferenceActions } from '../settings/useDisplayPreferenceActions';
import { showAppContextMenu } from '../menus/AppContextMenu';
import { useOptionalPersistentSessionHost, usePersistentSessionScene } from '../../navigation/PersistentSessionContext';
import { useTokens } from '../../theme';

export function usePasContextMenu(onHome?: () => void) {
  const host = useOptionalPersistentSessionHost();
  const session = usePersistentSessionScene(state => state.session);
  const hasMultiplePas = usePersistentSessionScene(state => state.sessions.length > 1);
  const setSettingsOpen = usePersistentSessionScene(state => state.setSettingsOpen);
  const { handleAppearanceChange } = useDisplayPreferenceActions();
  const t = useTokens();
  return () => showAppContextMenu([
    ...(onHome ? [{ key: 'home', label: '홈으로 돌아가기', onSelect: onHome }] : []),
    ...(hasMultiplePas && host ? [{ key: 'switch', label: '영구 세션 선택', onSelect: () => { void host.requestEntry(() => {}, false, true); } }] : []),
    { key: 'appearance', label: '밝기 전환', onSelect: () => handleAppearanceChange(t.mode === 'light' ? 'dark' : 'light') },
    { key: 'settings', label: '영구 세션 설정', onSelect: () => setSettingsOpen(true) },
  ], session?.agent_name ?? undefined);
}
