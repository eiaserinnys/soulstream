import React, { useLayoutEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { PlannerFolder } from '../api/plannerTypes';
import type { Folder } from '../api/types';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { createPlannerVisualRoles, useTokens } from '../theme';
import { ProjectListScreen } from './ProjectListScreen';
import { StarredFoldersScreen } from './StarredFoldersScreen';

export type FolderListTab = 'starred' | 'all';

/** The picker control owns the same typography and hit targets in both surfaces. */
export function FolderListScreen({ active = true, onOpenFolder, onOpenProject, onTabChange }: {
  active?: boolean;
  onOpenFolder?: (folder: PlannerFolder) => void;
  onOpenProject?: (folder: Folder, projectPageId: string) => void;
  onTabChange?: (tab: FolderListTab) => void;
}) {
  const t = useTokens();
  const [tab, setTab] = useState<FolderListTab>('starred');
  const [allVisited, setAllVisited] = useState(false);
  const styles = useMemo(() => {
    const planner = createPlannerVisualRoles(t);
    return StyleSheet.create({
      frame: { flex: 1 },
      tabs: { paddingHorizontal: planner.pageInset, paddingTop: t.uiSpacing.lg },
      content: { flex: 1 },
      hidden: { display: 'none' },
    });
  }, [t]);
  useLayoutEffect(() => { onTabChange?.(tab); }, [onTabChange, tab]);
  return <View testID="folder-list-screen" style={styles.frame}>
    <View testID="folder-list-tabs" style={styles.tabs}>
      <SettingsSegmentedControl<FolderListTab> id="folder-list" value={tab} onChange={(next) => {
        if (next === 'all') setAllVisited(true);
        setTab(next);
      }} options={[{ value: 'starred', label: '중요 작업' }, { value: 'all', label: '전체 폴더' }]} />
    </View>
    <View style={[styles.content, tab !== 'starred' && styles.hidden]}>
      <StarredFoldersScreen embedded active={active && tab === 'starred'} onOpenFolder={onOpenFolder} />
    </View>
    {allVisited ? <View style={[styles.content, tab !== 'all' && styles.hidden]}>
      <ProjectListScreen embedded onOpenProject={onOpenProject} />
    </View> : null}
  </View>;
}
