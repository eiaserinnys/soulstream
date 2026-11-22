import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useIsFocused } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SessionWorkspaceResponse } from '../../../packages/wire-schema/src/session_workspace';
import type { FeedStackParamList } from '../navigation/TabNavigator';
import { useDuoSideBand } from '../navigation/duoSideBand';
import { useRegisterDuoRailOverride } from '../navigation/phoneRailActions';
import { DuoSafeTop } from '../navigation/DuoSafeTop';
import { useSSEStream } from '../hooks/useSSEStream';
import { createApiClient } from '../api/client';
import { useSettingsStore } from '../store/settingsStore';
import { useChatStore } from '../store/chatStore';
import { createPlannerVisualRoles, useTokens } from '../theme';
import { LiquidGlassButton } from '../components/LiquidGlassButton';
import { GroupedGlassRow, GroupedGlassSheet } from '../components/planner/GroupedGlassSheet';
import { DisclosureIcon } from '../components/DisclosureIcon';
import { FrameLoading } from '../components/FrameLoading';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { isLegacyAttachmentImage, type AttachmentView } from '../lib/attachment-view';
import { TabletPaneHeader } from '../components/split/TabletPaneHeader';

type FileEntry = SessionWorkspaceResponse['files'][number];
type ReadEntry = SessionWorkspaceResponse['read_only'][number];
type Props = NativeStackScreenProps<FeedStackParamList, 'SessionFiles'>;
type Header = { title: string; branch: boolean; ahead: number; behind: number; refreshing: boolean; refresh: () => void };
const TURN_EVENTS = ['complete'] as const;

export function SessionFilesScreen({ route, navigation }: Props) {
  const duo = useDuoSideBand();
  const focused = useIsFocused();
  const [header, setHeader] = useState<Header | null>(null);
  useRegisterDuoRailOverride('session-files', duo && focused, [
    { id: 'back', label: '뒤로', icon: 'chevron-back', onPress: () => navigation.goBack() },
    { id: 'refresh', label: '다시 읽기', icon: 'refresh', onPress: () => header?.refresh() },
  ]);
  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => <FilesTitle header={header} />,
      headerRight: () => <RefreshButton header={header} />,
    });
  }, [navigation, header]);
  return <DuoSafeTop>
    {duo ? <TabletPaneHeader><FilesTitle header={header} /><View style={{ flex: 1 }} /><RefreshButton header={header} /></TabletPaneHeader> : null}
    <SessionFilesContent sessionId={route.params.sessionId} active={focused} onHeader={setHeader} />
  </DuoSafeTop>;
}

export function FilesTitle({ header }: { header: Header | null }) {
  const t = useTokens();
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs, flexShrink: 1 }}>
    {header?.branch ? <Ionicons name="git-branch-outline" size={t.iconSize.standard} color={t.colors.textTertiary} /> : null}
    <Text numberOfLines={1} style={{ ...t.foundation.typography.navigation, color: t.colors.textPrimary, flexShrink: 1 }}>{header?.title ?? '파일'}</Text>
    {header?.ahead ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>↑{header.ahead}</Text> : null}
    {header?.behind ? <Text style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>↓{header.behind}</Text> : null}
  </View>;
}

export function RefreshButton({ header }: { header: Header | null }) {
  const t = useTokens();
  return <LiquidGlassButton iconOnly variant="plain" accessibilityLabel="다시 읽기" onPress={() => header?.refresh()}>
    {header?.refreshing ? <ActivityIndicator color={t.colors.accent} /> : <Ionicons name="refresh" size={t.iconSize.navigation} color={t.colors.accent} />}
  </LiquidGlassButton>;
}

export function SessionFilesContent({ sessionId, active, onHeader }: { sessionId: string; active: boolean; onHeader?: (header: Header) => void }) {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => createApiClient(serverUrl), [serverUrl]);
  const [data, setData] = useState<SessionWorkspaceResponse | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cycle, setCycle] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const retries = useRef(0);
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async (reset = true) => {
    if (reset) retries.current = 0;
    const current = ++request.current;
    setRefreshing(true);
    try {
      const next = await api.getSessionWorkspace(sessionId);
      if (!mounted.current || current !== request.current) return;
      setData(next); setError(false); setCycle(value => value + 1);
    } catch {
      if (mounted.current && current === request.current) setError(true);
    } finally {
      if (mounted.current && current === request.current) { setLoading(false); setRefreshing(false); }
    }
  }, [api, sessionId]);
  useEffect(() => {
    mounted.current = active;
    if (active) { setLoading(true); void refresh(); }
    return () => { mounted.current = false; request.current++; };
  }, [active, refresh]);
  useEffect(() => {
    if (!active || refreshing || error || !(data?.snapshot?.state === 'pending' || data?.snapshot?.refreshing) || retries.current >= 10) return;
    const timer = setTimeout(() => { retries.current++; void refresh(false); }, 3000);
    return () => clearTimeout(timer);
  }, [active, data, error, refresh, refreshing, cycle]);
  useSSEStream({
    urlBuilder: () => api.sessionEventsUrl(sessionId, useChatStore.getState().lastEventIdBySession[sessionId]),
    connectionKey: sessionId, enabled: active && !!serverUrl, eventTypes: TURN_EVENTS,
    onEvent: () => { void refresh(); },
  });
  const snapshot = data?.snapshot;
  const folder = data?.root?.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const title = snapshot?.branch || folder || '파일';
  const spinning = refreshing || !!snapshot?.refreshing;
  const manualRefresh = useCallback(() => { void refresh(); }, [refresh]);
  useEffect(() => { onHeader?.({ title, branch: !!snapshot?.branch, ahead: snapshot?.ahead ?? 0, behind: snapshot?.behind ?? 0, refreshing: spinning, refresh: manualRefresh }); }, [title, snapshot?.branch, snapshot?.ahead, snapshot?.behind, spinning, manualRefresh, onHeader]);
  if (loading || (!error && data?.node.status === 'ok' && snapshot?.state === 'pending')) return <FrameLoading text="파일 상태를 읽는 중" />;
  return <SessionFilesView data={data} error={error} refreshing={refreshing} onRefresh={manualRefresh}
    expanded={expanded} onToggle={() => setExpanded(value => !value)} selected={selected} onSelect={setSelected} sessionId={sessionId} />;
}

export function SessionFilesView({ data, error, refreshing, onRefresh, expanded, onToggle, selected, onSelect, sessionId }: {
  data: SessionWorkspaceResponse | null; error: boolean; refreshing: boolean; onRefresh(): void;
  expanded: boolean; onToggle(): void; selected: string | null; onSelect(path: string | null): void; sessionId: string;
}) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => createApiClient(serverUrl), [serverUrl]);
  const groups = groupFiles(data?.files ?? []);
  const reads = data?.read_only ?? [];
  const visible = [...groups.flatMap(([, files]) => files), ...(expanded ? reads : [])];
  const items: AttachmentView[] = visible.map(file => {
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(file.path)}`;
    const name = file.path.split('/').pop() || file.path;
    const image = isLegacyAttachmentImage(name);
    return { key: file.path, name, byteSize: file.size, mimeType: image ? null : 'text/plain', previewKind: image ? 'image' : 'text',
      readContext: { type: 'session', id: sessionId }, source: { kind: 'ready', attachmentId: file.path, previewUrl: image ? url : null, originalUrl: `${url}&download=true` },
      loadText: signal => api.readSessionWorkspaceText(sessionId, file.path, signal),
      loadMedia: signal => api.readSessionWorkspaceMedia(sessionId, file.path, signal, { name }) };
  });
  const index = items.findIndex(item => item.key === selected);
  const message = error ? '파일을 불러오지 못했습니다' : data?.node.status === 'unsupported' ? '이 노드는 파일 보기를 지원하지 않습니다'
    : data?.node.status === 'no_workspace' ? '작업 폴더가 없습니다' : data?.node.status === 'error' ? '파일을 불러오지 못했습니다'
    : data?.snapshot?.state === 'not_git' ? 'Git 작업 폴더가 아닙니다' : null;
  return <View style={{ flex: 1 }}>
    <ScrollView testID="session-files-scroll" contentContainerStyle={{ paddingHorizontal: t.foundation.pageInset, paddingTop: t.uiSpacing.md, paddingBottom: t.uiSpacing.xl, gap: t.uiSpacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
      {data?.node.status === 'offline' ? <GroupedGlassSheet><View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm, paddingHorizontal: t.uiSpacing.md, paddingVertical: t.uiSpacing.sm, minHeight: t.hitTarget.min }}>
        <Ionicons name="cloud-offline-outline" size={t.iconSize.standard} color={t.colors.warningText} />
        <Text style={{ flex: 1, ...t.foundation.typography.meta, color: t.colors.textSecondary }}>노드 끊김{data.snapshot?.observed_at ? `, ${new Date(data.snapshot.observed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} 기준` : ''}</Text>
      </View></GroupedGlassSheet> : null}
      {message ? <View style={{ alignItems: 'center', gap: t.spacing.sm }}><Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>{message}</Text>
        {(error || data?.node.status === 'error') ? <LiquidGlassButton onPress={onRefresh}><Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text></LiquidGlassButton> : null}</View> : null}
      {!message && data && !data.files.length && data.node.status !== 'offline' ? <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary, textAlign: 'center' }}>바뀐 파일 없음</Text> : null}
      {groups.map(([dir, files]) => <View key={dir}>
        <Text numberOfLines={1} style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary, paddingHorizontal: t.uiSpacing.md, marginBottom: t.spacing.xs }}>{dir || '.'}</Text>
        <GroupedGlassSheet>{files.map(file => <FileRow key={file.path} file={file} onPress={() => onSelect(file.path)} />)}</GroupedGlassSheet>
      </View>)}
      {(reads.length > 0 || data?.attribution === 'partial') ? <GroupedGlassSheet>
        <GroupedGlassRow accessibilityLabel="읽기만 한 파일" accessibilityState={{ expanded }} onPress={onToggle} style={{ minHeight: planner.minHeight.row, paddingHorizontal: t.uiSpacing.md, paddingVertical: t.uiSpacing.sm }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
            <View style={{ width: planner.contentIconFrame, height: planner.contentIconFrame, alignItems: 'center', justifyContent: 'center' }}><Ionicons name="eye-outline" size={t.iconSize.standard} color={t.colors.fileRead} /></View>
            <Text style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary }}>읽기만 한 파일</Text>
            {data?.attribution === 'partial' ? <Text style={{ ...t.foundation.typography.label, color: t.colors.textSecondary, backgroundColor: t.colors.surfaceMuted, borderRadius: t.radius.capsule, paddingHorizontal: t.spacing.sm, overflow: 'hidden' }}>일부</Text> : null}
            <Text style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary }}>{reads.length}</Text><DisclosureIcon expanded={expanded} />
          </View>
        </GroupedGlassRow>
        {expanded ? reads.map(file => <FileRow key={file.path} file={file} onPress={() => onSelect(file.path)} />) : null}
      </GroupedGlassSheet> : null}
    </ScrollView>
    {index >= 0 ? <AttachmentPreviewModal item={items[index]} items={items} initialIndex={index} onClose={() => onSelect(null)} /> : null}
  </View>;
}

function groupFiles(files: FileEntry[]): [string, FileEntry[]][] {
  const groups = new Map<string, FileEntry[]>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups.entries()];
}

export function FileRow({ file, onPress }: { file: FileEntry | ReadEntry; onPress(): void }) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const changed = 'wrote' in file ? file : null;
  const activity = changed?.committed ? 'commit' : changed?.wrote ? 'write' : changed?.read || !changed ? 'read' : 'none';
  const icon = { write: 'pencil-outline', commit: 'git-commit-outline', read: 'eye-outline', none: 'document-outline' } as const;
  const color = { write: t.colors.fileWrite, commit: t.colors.fileCommit, read: t.colors.fileRead, none: t.colors.textTertiary };
  const name = file.path.split('/').pop() || file.path;
  return <GroupedGlassRow accessibilityLabel={name} onPress={onPress} style={{ minHeight: planner.minHeight.row, paddingHorizontal: t.uiSpacing.md, paddingVertical: t.uiSpacing.sm }}>
    <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm }}>
      <View style={{ width: planner.contentIconFrame, height: planner.contentIconFrame, alignItems: 'center', justifyContent: 'center' }}><Ionicons name={icon[activity]} size={t.iconSize.standard} color={color[activity]} /></View>
      <Text numberOfLines={1} style={{ flex: 1, ...t.foundation.typography.body, color: t.colors.textPrimary }}>{name}</Text>
      {changed && (changed.git_status === 'untracked' || changed.git_status === 'added') ? <Text style={{ ...t.foundation.typography.label, color: t.colors.textSecondary, backgroundColor: t.colors.surfaceMuted, borderRadius: t.radius.capsule, paddingHorizontal: t.spacing.sm, overflow: 'hidden' }}>새</Text> : null}
      {changed && (changed.added !== null || changed.deleted !== null) ? <Text style={{ ...t.foundation.typography.meta, fontVariant: ['tabular-nums'] }}>
        {changed.added !== null ? <Text style={{ color: t.colors.successText }}>+{changed.added}</Text> : null}
        {changed.deleted !== null && changed.deleted !== 0 ? <Text style={{ color: t.colors.errorText }}>{` −${changed.deleted}`}</Text> : null}
      </Text> : null}
    </View>
  </GroupedGlassRow>;
}
