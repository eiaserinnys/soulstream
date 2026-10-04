import React, { useLayoutEffect } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { TabNavigator } from '../navigation/TabNavigator';
import { ThreePaneLayout } from '../components/split/ThreePaneLayout';
import { TwoPaneWithDrawer } from '../components/split/TwoPaneWithDrawer';
import { useDeviceType } from '../theme';
import { useSessionStore } from '../store/sessionStore';
import { folders, entryShellSessions } from './fixtures';

/** Real phone tab/stack/home and tablet split tree. Metro injects fixture transport. */
export function ReviewEntryShell() {
  const device = useDeviceType();
  useLayoutEffect(() => {
    if (device === 'phone') return;
    const fixtureFolders = Array.from({ length: 20 }, (_, index) => ({
      ...folders[0], id: `public-shell-folder-${index}`, name: `공개 예시 폴더 ${String(index + 1).padStart(2, '0')}`,
      projectPageId: `public-shell-page-${index}`, sortOrder: index,
    }));
    const reviewFolders = useSessionStore.getState().catalog.folders.filter(folder => !folder.id.startsWith('public-shell-folder-'));
    useSessionStore.getState().setCatalog({ folders: [...reviewFolders, ...fixtureFolders], sessions: {} });
    useSessionStore.getState().setSessions(entryShellSessions);
  }, [device]);
  return <NavigationContainer>{device === 'phone' ? <TabNavigator />
    : device === 'tabletLandscape' ? <ThreePaneLayout /> : <TwoPaneWithDrawer />}</NavigationContainer>;
}
