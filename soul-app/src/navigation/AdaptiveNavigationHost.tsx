import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavigationContainer, type InitialState, type NavigationContainerRefWithCurrent, type NavigationState } from '@react-navigation/native';
import { useTokens, type DeviceType } from '../theme';
import { useUIStore } from '../store/uiStore';
import { useSearchStore } from '../store/searchStore';
import { useSessionStore } from '../store/sessionStore';
import { recordStaticNavigationRoute } from '../lib/session-diagnostics';
import { navigationRef } from './navigationRef';
import { useNavigationViewUsageEvents } from './useNavigationViewUsageEvents';
import { useLayoutContinuity } from './LayoutContinuityContext';
import { usePersistentSessionHost } from './PersistentSessionContext';
import { PhonePanelHistoryProvider } from './phonePanelHistory';
import { TabNavigator } from './TabNavigator';
import { TabletNavigator } from './TabletNavigator';
import { buildPhoneState, buildTabletState, readPhoneLocation, readTabletLocation, type NormalizedNavigationLocation, type TabletContinuityEffects } from './layoutNavigationState';
import { SETTINGS_WORKSPACE_CONTINUITY_KEY, type SettingsWorkspaceContinuityState } from './settingsWorkspaceContinuity';

type Family = 'phone' | 'tablet';
type Prepared = { family: Family; initialState?: InitialState; restored: boolean };

/** The authentication instance owns memory; only the router container changes family. */
export function AdaptiveNavigationHost({ device, containerRef = navigationRef }: {
  device: DeviceType;
  containerRef?: NavigationContainerRefWithCurrent<any>;
}) {
  const family: Family = device === 'phone' ? 'phone' : 'tablet';
  const continuity = useLayoutContinuity();
  const host = usePersistentSessionHost();
  const t = useTokens();
  const { recordNavigationView } = useNavigationViewUsageEvents();
  const [prepared, setPrepared] = useState<Prepared>({ family, restored: false });
  const requestedFamily = useRef(family);
  requestedFamily.current = family;
  const latestState = useRef<NavigationState | undefined>(undefined);

  const readLocation = useCallback((source: Family, state: NavigationState | InitialState | undefined) => {
    const workspace = continuity.getViewState<SettingsWorkspaceContinuityState>(SETTINGS_WORKSPACE_CONTINUITY_KEY);
    const previousLocation = continuity.getLastLocation();
    if (source === 'phone') {
      return readPhoneLocation(state, { previousLocation, settingsCategory: workspace?.category });
    }
    const ui = useUIStore.getState();
    const overlayKey = ui.selectedFolderPageId ?? ui.selectedCardId;
    const overlayStep = overlayKey
      ? continuity.getViewState<'detail' | 'chat'>(JSON.stringify(['folder-overlay', overlayKey]))
      : undefined;
    const effectiveActiveSessionId = overlayKey
      ? (overlayStep === 'detail'
        ? null
        : overlayStep === 'chat'
          ? ui.activeSessionId
          : (ui.overlaySessionExplicit ? ui.activeSessionId : null))
      : ui.activeSessionId;
    const folder = useSessionStore.getState().catalog.folders.find(item => item.projectPageId === ui.selectedFolderPageId);
    const previousFolder = previousLocation && 'folder' in previousLocation ? previousLocation.folder : undefined;
    return readTabletLocation(state, {
      previousLocation, lastMainFocus: ui.lastMainFocus, activeSection: ui.activeSection,
      folderOverlayVisible: ui.folderOverlayVisible, selectedCardId: ui.selectedCardId,
      activeSessionId: effectiveActiveSessionId, settingsVisible: ui.settingsVisible,
      settingsCategory: workspace?.category,
      // Both platforms use SettingsScreen's workspace, including recurring jobs.
      selectedFolder: ui.selectedFolderPageId ? {
        folderPageId: ui.selectedFolderPageId,
        folderTitle: folder?.name ?? (previousFolder?.folderPageId === ui.selectedFolderPageId ? previousFolder.folderTitle : ''),
        folderId: folder?.id ?? (previousFolder?.folderPageId === ui.selectedFolderPageId ? previousFolder.folderId : undefined),
      } : null,
      searchActive: useSearchStore.getState().tabletActive,
      searchQuery: useSearchStore.getState().query,
      pasSelectedCardId: host.store.getState().selectedCardId,
    });
  }, [continuity, host.store]);

  const capture = useCallback((state?: NavigationState, ready = false) => {
    if (!state || requestedFamily.current !== prepared.family) return;
    latestState.current = state;
    if (prepared.family === 'phone') continuity.setPhoneStateSnapshot(state);
    else continuity.setTabletStateSnapshot(state);
    continuity.setLastLocation(readLocation(prepared.family, state));
    recordNavigationView(state, ready);
    recordStaticNavigationRoute(state);
  }, [continuity, prepared.family, readLocation, recordNavigationView]);

  useEffect(() => {
    const recordOverlay = () => {
      if (requestedFamily.current !== prepared.family || prepared.family !== 'tablet' || !latestState.current) return;
      continuity.setLastLocation(readLocation('tablet', latestState.current));
    };
    const subscriptions = [useUIStore.subscribe(recordOverlay), useSearchStore.subscribe((state, previous) => {
      if (!state.tabletActive && previous.tabletActive && useUIStore.getState().lastMainFocus === 'search') {
        useUIStore.getState().setLastMainFocus('feed');
      }
      recordOverlay();
    }), host.store.subscribe(recordOverlay)];
    return () => subscriptions.forEach(remove => remove());
  }, [continuity, host.store, prepared.family, readLocation]);

  useLayoutEffect(() => {
    if (prepared.family === family) return;
    const state = latestState.current ?? prepared.initialState;
    const location = state ? readLocation(prepared.family, state) : continuity.getLastLocation();
    if (state) {
      if (prepared.family === 'phone') continuity.setPhoneStateSnapshot(state);
      else continuity.setTabletStateSnapshot(state);
    }
    continuity.setLastLocation(location);
    latestState.current = undefined;
    if (!location) {
      setPrepared({ family, restored: false });
      return;
    }
    const pas = location.kind === 'persistentSession'
      || (location.kind === 'cardDetail' && location.pasCard)
      || (location.kind === 'markdownDocument' && location.fromPersistent);
    if (pas) {
      host.store.setState({ visible: true });
      if (location.kind === 'cardDetail') host.store.getState().selectCard(location.cardId);
    } else host.store.getState().leave();

    if (family === 'phone') {
      // SettingsScreen restores its workspace; legacy stack routes remain supported.
      const phoneLocation: NormalizedNavigationLocation = location.kind === 'recurringJobs'
        ? { originTab: 'SettingsTab', kind: 'settings', category: 'recurring-jobs' } : location;
      const initialState = buildPhoneState(phoneLocation, continuity.getPhoneStateSnapshot());
      const ui = useUIStore.getState();
      ui.closeFolderOverlay();
      ui.clearCardOverlay();
      ui.closeSettings();
      setPrepared({ family, initialState, restored: true });
    } else {
      const { initialState, tabletEffects } = buildTabletState(location);
      applyTabletEffects(tabletEffects, location);
      setPrepared({ family, initialState, restored: true });
    }

    function applyTabletEffects(effects: TabletContinuityEffects, location: NormalizedNavigationLocation) {
      const ui = useUIStore.getState();
      const sameCard = effects.cardOverlay?.cardId === ui.selectedCardId;
      const cardSession = sameCard ? ui.activeSessionId : null;
      ui.closeFolderOverlay();
      ui.closeSettings();
      if (!sameCard) { ui.clearCardOverlay(); ui.setActiveSessionId(null); }
      if (effects.activeSectionKind === 'daily') ui.setActiveSection({ kind: 'daily', date: ui.todayDate });
      const overlayKey = effects.folderOverlay?.folderPageId ?? effects.cardOverlay?.cardId;
      if (overlayKey) {
        continuity.setViewState(JSON.stringify(['folder-overlay', overlayKey]),
          (effects.folderOverlay?.sessionId ?? effects.cardOverlay?.sessionId) ? 'chat' : 'detail');
      }
      if (effects.folderOverlay) {
        const overlay = effects.folderOverlay;
        ui.openFolderOverlay(overlay.folderPageId, overlay.sessionId ?? null);
      }
      if (effects.cardOverlay) {
        if (sameCard) useUIStore.setState({ folderOverlayVisible: true, activeSessionId: effects.cardOverlay.sessionId ?? cardSession, overlaySessionExplicit: Boolean(effects.cardOverlay.sessionId) });
        else ui.openCardOverlay(effects.cardOverlay.cardId, effects.cardOverlay.sessionId ?? null);
      }
      if (effects.sessionOverlay) {
        const overlay = effects.sessionOverlay;
        ui.openSessionOverlay(overlay.sessionId, overlay.focusEventId, overlay.storyOpenRequestId);
      }
      if (effects.settingsVisible) ui.openSettings();
      if (effects.recurringJobsPanel) {
        const saved = continuity.getViewState<SettingsWorkspaceContinuityState>(SETTINGS_WORKSPACE_CONTINUITY_KEY);
        continuity.setViewState<SettingsWorkspaceContinuityState>(SETTINGS_WORKSPACE_CONTINUITY_KEY, {
          category: 'recurring-jobs', jobs: effects.recurringJobsPanel, persistent: saved?.persistent ?? { kind: 'list' },
        });
      }
      const search = useSearchStore.getState();
      if (effects.searchActive) { search.setQuery(effects.searchQuery ?? ''); search.openTabletSearch(); }
      else search.closeTabletSearch();
      if (effects.pasSelectedCardId !== undefined) host.store.setState({ selectedCardId: effects.pasSelectedCardId });
      if (effects.lastMainFocus) ui.setLastMainFocus(effects.lastMainFocus);
      // A document above a card/folder keeps that underlying context.
      if (location.kind === 'markdownDocument' && !location.fromPersistent) {
        if (location.folder) ui.openFolderOverlay(location.folder.folderPageId, null);
        if (location.cardId) ui.openCardOverlay(location.cardId, null);
      }
    }
  }, [continuity, family, host.store, prepared, readLocation]);

  // Prepare stores before mounting destination screens; do not expose a default Main.
  if (prepared.family !== family) return null;
  const initialTab = prepared.initialState?.routes[prepared.initialState.index ?? 0]?.name;
  return <PhonePanelHistoryProvider>
    <NavigationContainer key={family} ref={containerRef} initialState={prepared.initialState}
      onReady={() => capture(containerRef.getRootState(), true)} onStateChange={state => capture(state)}
      theme={{
        dark: t.mode === 'dark',
        colors: { primary: t.colors.accent, background: t.colors.background, card: t.colors.surface,
          text: t.colors.textPrimary, border: t.colors.border, notification: t.colors.error },
        fonts: { regular: { fontFamily: 'System', fontWeight: '400' }, medium: { fontFamily: 'System', fontWeight: '500' },
          bold: { fontFamily: 'System', fontWeight: '700' }, heavy: { fontFamily: 'System', fontWeight: '800' } },
      }}>
      {family === 'phone' ? <TabNavigator initialTab={initialTab} /> : <TabletNavigator restored={prepared.restored} />}
    </NavigationContainer>
  </PhonePanelHistoryProvider>;
}
