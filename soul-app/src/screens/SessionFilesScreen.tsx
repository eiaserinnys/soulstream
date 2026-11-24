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
import { formatCardTime } from '../lib/card-check-item-summary';

type FileEntry = SessionWorkspaceResponse['files'][number];
type ReadEntry = SessionWorkspaceResponse['read_only'][number];
type Props = NativeStackScreenProps<FeedStackParamList, 'SessionFiles'>;
type Header = { title: string; branch: boolean; ahead: number; behind: number; refreshing: boolean; disabled: boolean; refresh: () => void };
const TURN_EVENTS = ['complete'] as const;

export function SessionFilesScreen({ route, navigation }: Props) {
  const duo = useDuoSideBand();
  const focused = useIsFocused();
  const [header, setHeader] = useState<Header | null>(null);
  useRegisterDuoRailOverride('session-files', duo && focused, [
    { id: 'back', label: '뒤로', icon: 'chevron-back', onPress: () => navigation.goBack() },
    { id: 'refresh', label: '다시 읽기', icon: 'refresh', disabled: !header || header.disabled, onPress: () => { if (header && !header.disabled) header.refresh(); } },
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
    <Text selectable={false} numberOfLines={1} style={{ ...t.foundation.typography.navigation, color: t.colors.textPrimary, flexShrink: 1 }}>{header?.title ?? '파일'}</Text>
    {header?.ahead ? <Text selectable={false} style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>↑{header.ahead}</Text> : null}
    {header?.behind ? <Text selectable={false} style={{ ...t.foundation.typography.meta, color: t.colors.textSecondary }}>↓{header.behind}</Text> : null}
  </View>;
}

export function RefreshButton({ header }: { header: Header | null }) {
  const t = useTokens();
  return <LiquidGlassButton iconOnly variant="plain" accessibilityLabel="다시 읽기" disabled={!header || header.disabled} onPress={() => header?.refresh()}>
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
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const [cycle, setCycle] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const retries = useRef(0);
  const mounted = useRef(false);
  const request = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async (reset = true) => {
    if (inFlight.current) return;
    inFlight.current = true;
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
      if (current === request.current) {
        inFlight.current = false;
        if (mounted.current) { setLoading(false); setRefreshing(false); }
      }
    }
  }, [api, sessionId]);
  useEffect(() => {
    mounted.current = active;
    if (active) { setLoading(true); setPullRefreshing(false); void refresh(); }
    return () => { mounted.current = false; request.current++; inFlight.current = false; };
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
  const firstLoading = loading || (!error && data?.node.status === 'ok' && snapshot?.state === 'pending');
  const spinning = !firstLoading && (refreshing || (!error && !!snapshot?.refreshing));
  const manualRefresh = useCallback(() => { void refresh(); }, [refresh]);
  const pullRefresh = useCallback(async () => {
    if (inFlight.current || (!error && snapshot?.refreshing)) return;
    setPullRefreshing(true);
    try { await refresh(); } finally { if (mounted.current) setPullRefreshing(false); }
  }, [refresh, error, snapshot?.refreshing]);
  useEffect(() => { onHeader?.({ title, branch: !!snapshot?.branch, ahead: snapshot?.ahead ?? 0, behind: snapshot?.behind ?? 0, refreshing: spinning, disabled: firstLoading || spinning, refresh: manualRefresh }); }, [title, snapshot?.branch, snapshot?.ahead, snapshot?.behind, spinning, firstLoading, manualRefresh, onHeader]);
  if (firstLoading) return <FrameLoading testID="session-files-loading" text="파일 상태를 읽는 중" />;
  return <SessionFilesView data={data} error={error} refreshing={pullRefreshing} onRefresh={manualRefresh} onPullRefresh={pullRefresh}
    expanded={expanded} onToggle={() => setExpanded(value => !value)} selected={selected} onSelect={setSelected} sessionId={sessionId} />;
}

export function SessionFilesView({ data, error, refreshing, onRefresh, onPullRefresh = onRefresh, expanded, onToggle, selected, onSelect, sessionId }: {
  data: SessionWorkspaceResponse | null; error: boolean; refreshing: boolean; onRefresh(): void;
  onPullRefresh?(): void;
  expanded: boolean; onToggle(): void; selected: string | null; onSelect(path: string | null): void; sessionId: string;
}) {
  const t = useTokens();
  const planner = useMemo(() => createPlannerVisualRoles(t), [t]);
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => createApiClient(serverUrl), [serverUrl]);
  const groups = groupFiles(data?.files ?? []);
  const reads = data?.read_only ?? [];
  const items: AttachmentView[] = useMemo(() => {
    const visible = [...groupFiles(data?.files ?? []).flatMap(([, files]) => files), ...(expanded ? data?.read_only ?? [] : [])];
    return visible.map(file => {
      const url = `/api/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(file.path)}`;
      const name = file.path.split('/').pop() || file.path;
      const image = isLegacyAttachmentImage(name);
      return { key: file.path, name, byteSize: file.size, mimeType: image ? null : 'text/plain', previewKind: image ? 'image' : 'text',
        revision: JSON.stringify('wrote' in file
          ? [file.size, file.added, file.deleted, file.git_status, file.last_activity_at, data?.snapshot?.observed_at]
          : [file.size, file.last_read_at, data?.snapshot?.observed_at]),
        pdfCache: 'none', readContext: { type: 'session', id: sessionId }, source: { kind: 'ready', attachmentId: file.path, previewUrl: image ? url : null, originalUrl: `${url}&download=true` },
        loadText: signal => api.readSessionWorkspaceText(sessionId, file.path, signal),
        loadMedia: signal => api.readSessionWorkspaceMedia(sessionId, file.path, signal, { name }) };
    });
  }, [data?.files, data?.read_only, data?.snapshot?.observed_at, expanded, sessionId, api]);
  const index = items.findIndex(item => item.key === selected);
  const message = error ? '파일을 불러오지 못했습니다' : data?.node.status === 'unsupported' ? '이 노드는 파일 보기를 지원하지 않습니다'
    : data?.node.status === 'no_workspace' ? '작업 폴더가 없습니다' : data?.node.status === 'error' ? '파일을 불러오지 못했습니다'
    : data?.snapshot?.state === 'not_git' ? 'Git 작업 폴더가 아닙니다' : null;
  const empty = !message && data && !data.files.length && data.node.status !== 'offline' ? '바뀐 파일 없음' : null;
  const centerState = !!(message || empty) && groups.length === 0 && reads.length === 0 && data?.node.status !== 'offline';
  return <View style={{ flex: 1 }}>
    <ScrollView testID="session-files-scroll" contentContainerStyle={{ flexGrow: 1, paddingHorizontal: t.foundation.pageInset, paddingTop: t.uiSpacing.md, paddingBottom: t.uiSpacing.xl, gap: t.uiSpacing.lg }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onPullRefresh} />}>
      {data?.node.status === 'offline' ? <GroupedGlassSheet><View style={{ flexDirection: 'row', alignItems: 'center', gap: t.uiSpacing.sm, paddingHorizontal: t.uiSpacing.md, paddingVertical: t.uiSpacing.sm, minHeight: t.hitTarget.min }}>
        <Ionicons name="cloud-offline-outline" size={t.iconSize.standard} color={t.colors.warningText} />
        <Text selectable={false} style={{ flex: 1, ...t.foundation.typography.meta, color: t.colors.textSecondary }}>노드 끊김{data.snapshot?.observed_at ? `, ${formatCardTime(data.snapshot.observed_at)} 기준` : ''}</Text>
      </View></GroupedGlassSheet> : null}
      {message || empty ? <View testID="session-files-state" style={{ alignItems: 'center', ...(centerState ? { flex: 1, justifyContent: 'center' } : null) }}>
        <View testID="session-files-state-content" style={{ alignItems: 'center', gap: t.spacing.sm }}>
        <Text selectable={false} style={{ ...t.foundation.typography.body, color: t.colors.textSecondary, textAlign: 'center' }}>{message || empty}</Text>
        {centerState && data?.attribution === 'partial' ? <Text selectable={false} style={{ ...t.foundation.typography.label, color: t.colors.textSecondary }}>일부</Text> : null}
        {(error || data?.node.status === 'error') ? <LiquidGlassButton variant="primary" onPress={onRefresh}><Text style={{ ...t.foundation.typography.body, color: t.colors.accentText }}>다시 시도</Text></LiquidGlassButton> : null}
        </View>
      </View> : null}
      {groups.map(([dir, files]) => <View key={dir}>
        <Text selectable={false} numberOfLines={1} style={{ ...t.foundation.typography.meta, color: t.colors.textTertiary, paddingHorizontal: t.uiSpacing.md, marginBottom: t.spacing.xs }}>{dir || '.'}</Text>
        <GroupedGlassSheet>{files.map(file => <FileRow key={file.path} file={file} onPress={() => onSelect(file.path)} />)}</GroupedGlassSheet>
      </View>)}
      {(reads.length > 0 || (groups.length > 0 && data?.attribution === 'partial')) ? <GroupedGlassSheet>
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
      </Text> : changed && (changed.session_added !== null || changed.session_deleted !== null) ? <Text accessibilityLabel={`세션 기록 기준 추가 ${changed.session_added ?? 0}줄, 삭제 ${changed.session_deleted ?? 0}줄`} style={{ ...t.foundation.typography.meta, fontVariant: ['tabular-nums'] }}>
        {changed.session_added ? <Text style={{ color: t.colors.successText }}>+{changed.session_added}</Text> : null}
        {changed.session_deleted ? <Text style={{ color: t.colors.errorText }}>{` −${changed.session_deleted}`}</Text> : null}
      </Text> : null}
    </View>
  </GroupedGlassRow>;
}
