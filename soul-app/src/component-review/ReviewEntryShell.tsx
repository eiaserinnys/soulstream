import React, { useLayoutEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { TabNavigator } from '../navigation/TabNavigator';
import { ThreePaneLayout } from '../components/split/ThreePaneLayout';
import { TwoPaneWithDrawer } from '../components/split/TwoPaneWithDrawer';
import { useDeviceType } from '../theme';
import { useSessionStore } from '../store/sessionStore';
import { entryShellCatalogSessions, entryShellFolders, entryShellSessions } from './fixtures';

/** Real phone tab/stack/home and tablet split tree. Metro injects fixture transport. */
export function ReviewEntryShell() {
  const device = useDeviceType();
  useLayoutEffect(() => {
    if (device === 'phone') return;
    const reviewFolders = useSessionStore.getState().catalog.folders.filter(folder => !folder.id.startsWith('public-shell-folder-'));
    useSessionStore.getState().setCatalog({ folders: [...reviewFolders, ...entryShellFolders], sessions: entryShellCatalogSessions });
    useSessionStore.getState().setSessions(entryShellSessions);
  }, [device]);
  return <NavigationContainer>{device === 'phone' ? <TabNavigator />
    : device === 'tabletLandscape' ? <ThreePaneLayout /> : <TwoPaneWithDrawer />}</NavigationContainer>;
}
