import { usePersistentDraft } from '../../hooks/usePersistentDraft';
import React, { useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import type { ApiClient } from '../../api/client';
import { usePlannerStarred } from '../../hooks/usePlannerStarred';
import { buildPlannerProjectTreeRows } from '../../lib/planner-project-tree';
import { useSessionStore } from '../../store/sessionStore';
import { useTokens } from '../../theme';
import { AppModalSurface } from '../AppModalSurface';
import { GlassButton } from '../GlassSurface';
import { SettingsSegmentedControl } from '../settings/SettingsSegmentedControl';
import { ProjectTreeSheet } from './ProjectTreeSheet';
import { StarredFolderList } from './StarredFolderList';
import { cardStyles } from './Card.styles';
import { Text } from 'react-native';

export function FolderSelectionSheet({ api, onSelect, onClose, draftScope }: {
  draftScope?: string; api: ApiClient | null; onSelect(folderId: string): void; onClose(): void;
}) {
  const t = useTokens();
  const styles = useMemo(() => cardStyles(t), [t]);
  const folders = useSessionStore((state) => state.catalog.folders);
  const [tab, setTab] = useState<'starred' | 'all'>('starred');
  const draft = usePersistentDraft('folder-selection-search', [draftScope ?? 'review'], '');
  const { value: query, setValue: setQuery } = draft;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const starred = usePlannerStarred(api);
  const selectable = folders.filter((folder) => !folder.archived && folder.id !== 'llm' && folder.id !== 'claude');
  const needle = query.trim().toLocaleLowerCase();
  const allRows = buildPlannerProjectTreeRows(selectable, needle ? new Set(selectable.map((folder) => folder.id)) : expanded);
  const rows = needle ? allRows.filter((row) => row.folder.name.toLocaleLowerCase().includes(needle)) : allRows;
  const choose = (id: string) => { onSelect(id); onClose(); };
  return <AppModalSurface visible modalId="modal_card_assignment" variant="expanded" presentationStyle="pageSheet" onRequestClose={onClose}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>폴더 선택</Text>
      <TextInput editable={draft.ready} accessibilityLabel="폴더 검색" placeholder="폴더 검색" value={query} onChangeText={setQuery} style={styles.input} placeholderTextColor={t.colors.textPlaceholder} />
      <SettingsSegmentedControl<'starred' | 'all'> id="folder-selection" value={tab} onChange={setTab} options={[{ value: 'starred', label: '별표' }, { value: 'all', label: '전체' }]} />
      {tab === 'starred' ? <StarredFolderList folders={starred.data.items.filter((folder) => folder.page.title.toLocaleLowerCase().includes(needle))}
        loading={starred.loading} error={starred.error} hasMore={!!starred.data.nextCursor} onLoadMore={starred.loadMore}
        onSelect={(folder) => choose(folder.folderId)} />
        : <ProjectTreeSheet rows={rows} onToggle={(id) => setExpanded((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
          onSelectFolder={(folder) => choose(folder.id)} onOpen={(folder) => choose(folder.id)} onLongPress={() => undefined} />}
      <View style={styles.actions}><GlassButton onPress={onClose}><Text style={styles.body}>닫기</Text></GlassButton></View>
    </ScrollView>
  </AppModalSurface>;
}
