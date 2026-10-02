import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import type {
  BoardItem,
  CustomViewDocument,
  MarkdownDocument,
} from '../../api/boardItemEndpoints';
import type { ApiClient } from '../../api/client';
import { usePlannerFolder } from '../../hooks/usePlannerFolder';
import {
  buildCustomViewBindings,
  renderCustomViewHtml,
} from '../../lib/custom-view-renderer';
import { useSessionStore } from '../../store/sessionStore';
import { createPlannerVisualRoles, useTokens, type DesignTokens } from '../../theme';
import { DisclosureIcon } from '../DisclosureIcon';
import { PlannerMarkdownText } from './PlannerMarkdownText';
import { GroupedGlassSheet } from './GroupedGlassSheet';
import { PlannerSectionHeader } from './PlannerSectionHeader';
import { captureAuthScope, useAuthScopeGeneration } from '../../lib/auth-scope';

const INLINE_TYPES = new Set<BoardItem['itemType']>([
  'markdown',
  'custom_view',
  'asset',
]);

export function FolderBoardContent({
  api,
  folderId,
  active = true,
}: {
  api: ApiClient | null;
  folderId: string;
  active?: boolean;
}) {
  const t = useTokens();
  const styles = useMemo(() => makeStyles(t), [t]);
  const scopeGeneration = useAuthScopeGeneration();
  const [items, setItems] = useState<BoardItem[]>([]);
  const [itemsOwner, setItemsOwner] = useState(scopeGeneration);
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const folder = usePlannerFolder(api, folderId, active,false);
  const sessions = useSessionStore((state) => state.sessions);
  const bindings = useMemo(
    () => buildCustomViewBindings(folder.data, sessions),
    [folder.data, sessions],
  );

  useEffect(() => {
    const requestScopeGeneration = scopeGeneration;
    setItemsOwner(requestScopeGeneration);
    setSectionExpanded(false);
    setExpandedId(null);
    setItems([]);
    if (!api || !active) {
      setStatus('idle');
      return;
    }
    let current = true;
    setStatus('loading');
    void api.getFolderBoardItems(folderId)
      .then((next) => {
        if (!current || captureAuthScope().generation !== requestScopeGeneration) return;
        setItems(next.filter((item) => INLINE_TYPES.has(item.itemType)));
        setStatus('ready');
      })
      .catch(() => {
        if (current && captureAuthScope().generation === requestScopeGeneration) setStatus('error');
      });
    return () => { current = false; };
  }, [active, api, folderId, scopeGeneration]);

  const ownsItems = itemsOwner === scopeGeneration;
  const visibleItems = ownsItems ? items : [];
  const visibleStatus = ownsItems ? status : active ? 'loading' : 'idle';

  return (
    <View testID="task-board-content" style={styles.group}>
      <PlannerSectionHeader title="보드" testID="task-board-disclosure"
        expanded={sectionExpanded} disclosureFrameTestID="task-board-disclosure-frame"
        onToggle={() => {
          setSectionExpanded((current) => {
            if (current) setExpandedId(null);
            return !current;
          });
        }} />
      {sectionExpanded ? <GroupedGlassSheet>
        {visibleStatus === 'loading' ? (
          <View testID="task-board-loading" style={styles.stateRow}>
            <ActivityIndicator color={t.colors.accent} />
          </View>
        ) : null}
        {visibleStatus === 'error' ? (
          <View style={styles.stateRow}>
            <Text style={styles.error}>보드 항목을 불러오지 못했습니다.</Text>
          </View>
        ) : null}
        {visibleStatus === 'ready' && visibleItems.length === 0 ? (
          <View style={styles.stateRow}>
            <Text style={styles.empty}>보드에 표시할 문서가 없습니다.</Text>
          </View>
        ) : null}
        {visibleItems.map((item) => (
          <FolderBoardItemCard
            key={item.id}
            api={api}
            item={item}
            expanded={expandedId === item.id}
            onToggle={() => setExpandedId((current) => current === item.id ? null : item.id)}
            bindings={bindings}
            styles={styles}
            t={t}
          />
        ))}
      </GroupedGlassSheet> : null}
    </View>
  );
}

function FolderBoardItemCard({
  api,
  item,
  expanded,
  onToggle,
  bindings,
  styles,
  t,
}: {
  api: ApiClient | null;
  item: BoardItem;
  expanded: boolean;
  onToggle(): void;
  bindings: ReturnType<typeof buildCustomViewBindings>;
  styles: ReturnType<typeof makeStyles>;
  t: DesignTokens;
}) {
  if (item.itemType === 'asset') {
    const title = metadataText(item, 'originalName') || metadataText(item, 'title') || '첨부 파일';
    const url = metadataText(item, 'signedUrl') || metadataText(item, 'sourceUrl');
    const mimeType = metadataText(item, 'mimeType') || 'application/octet-stream';
    const byteSize = metadataNumber(item, 'byteSize');
    const kind = assetKind(mimeType);
    return (
      <View testID={`task-board-asset-${item.id}`} style={styles.item}>
        <TouchableOpacity
          testID={`task-board-disclosure-${item.id}`}
          accessibilityLabel={`${title} ${expanded ? '접기' : '펼치기'}`}
          accessibilityState={{ expanded }}
          style={styles.cardHeader}
          onPress={onToggle}
        >
          <View testID={`task-board-icon-${item.id}`} style={styles.iconFrame}>
            <Text style={styles.iconGlyph}>📎</Text>
          </View>
          <View style={styles.assetTitle}>
            <Text style={styles.cardTitle} numberOfLines={2}>{title}</Text>
            <Text style={styles.assetMeta} numberOfLines={1}>
              {[mimeType, formatByteSize(byteSize)].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <View testID={`task-board-disclosure-frame-${item.id}`} style={styles.disclosureFrame}>
            <DisclosureIcon
              expanded={expanded}
              color={t.colors.textMuted}
              size={t.iconSize.compact}
            />
          </View>
        </TouchableOpacity>
        {expanded && url && kind !== 'file' ? (
          <WebView
            testID={`task-board-asset-media-${item.id}`}
            source={{ html: renderAssetMediaHtml(kind, url, title) }}
            originWhitelist={['about:blank', 'https://*']}
            javaScriptEnabled={false}
            allowFileAccess={false}
            mediaPlaybackRequiresUserAction
            scrollEnabled={false}
            style={styles.assetMedia}
          />
        ) : null}
        {expanded && url ? (
          <TouchableOpacity
            style={styles.assetOpenAction}
            onPress={() => { void WebBrowser.openBrowserAsync(url); }}
          >
            <Text style={styles.openLabel}>열기</Text>
          </TouchableOpacity>
        ) : null}
        {expanded && !url ? <Text style={styles.error}>파일 주소를 불러오지 못했습니다.</Text> : null}
      </View>
    );
  }
  const fallback = item.itemType === 'markdown' ? '제목 없는 문서' : 'Flux 카드';
  const title = metadataText(item, 'title') || fallback;
  return (
    <View testID={`task-board-${item.itemType}-${item.id}`} style={styles.item}>
      <TouchableOpacity
        testID={`task-board-disclosure-${item.id}`}
        accessibilityLabel={`${title} ${expanded ? '접기' : '펼치기'}`}
        accessibilityState={{ expanded }}
        style={styles.cardHeader}
        onPress={onToggle}
      >
        <View testID={`task-board-icon-${item.id}`} style={styles.iconFrame}>
          <Text style={styles.iconGlyph}>{item.itemType === 'markdown' ? '📄' : '▦'}</Text>
        </View>
        <Text style={styles.cardTitle} numberOfLines={2}>{title}</Text>
        <View testID={`task-board-disclosure-frame-${item.id}`} style={styles.disclosureFrame}>
          <DisclosureIcon
            expanded={expanded}
            color={t.colors.textMuted}
            size={t.iconSize.compact}
          />
        </View>
      </TouchableOpacity>
      {expanded && item.itemType === 'markdown' ? (
        <InlineMarkdown api={api} documentId={item.itemId} styles={styles} t={t} />
      ) : null}
      {expanded && item.itemType === 'custom_view' ? (
        <InlineCustomView
          api={api}
          customViewId={item.itemId}
          bindings={bindings}
          styles={styles}
        />
      ) : null}
    </View>
  );
}

function InlineMarkdown({
  api,
  documentId,
  styles,
  t,
}: {
  api: ApiClient | null;
  documentId: string;
  styles: ReturnType<typeof makeStyles>;
  t: DesignTokens;
}) {
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [error, setError] = useState(false);
  const scopeGeneration = useAuthScopeGeneration();
  const [ownerGeneration, setOwnerGeneration] = useState(scopeGeneration);
  useEffect(() => {
    setOwnerGeneration(scopeGeneration);
    setDocument(null);
    setError(false);
    if (!api) return;
    let current = true;
    void api.getMarkdownDocument(documentId)
      .then((next) => {
        if (current && captureAuthScope().generation === scopeGeneration) setDocument(next);
      })
      .catch(() => {
        if (current && captureAuthScope().generation === scopeGeneration) setError(true);
      });
    return () => { current = false; };
  }, [api, documentId, scopeGeneration]);
  const ownsDocument = ownerGeneration === scopeGeneration;
  if (ownsDocument && error) return <Text style={styles.error}>문서 본문을 불러오지 못했습니다.</Text>;
  if (!ownsDocument || !document) return <ActivityIndicator color={t.colors.accent} />;
  return (
    <View testID="task-board-markdown-body" style={styles.body}>
      <PlannerMarkdownText markdown={document.body} />
    </View>
  );
}

function InlineCustomView({
  api,
  customViewId,
  bindings,
  styles,
}: {
  api: ApiClient | null;
  customViewId: string;
  bindings: ReturnType<typeof buildCustomViewBindings>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [document, setDocument] = useState<CustomViewDocument | null>(null);
  const [error, setError] = useState(false);
  const scopeGeneration = useAuthScopeGeneration();
  const [ownerGeneration, setOwnerGeneration] = useState(scopeGeneration);
  useEffect(() => {
    setOwnerGeneration(scopeGeneration);
    setDocument(null);
    setError(false);
    if (!api) return;
    let current = true;
    void api.getCustomView(customViewId)
      .then((next) => {
        if (current && captureAuthScope().generation === scopeGeneration) setDocument(next);
      })
      .catch(() => {
        if (current && captureAuthScope().generation === scopeGeneration) setError(true);
      });
    return () => { current = false; };
  }, [api, customViewId, scopeGeneration]);
  const ownsDocument = ownerGeneration === scopeGeneration;
  if (ownsDocument && error) return <Text style={styles.error}>Flux 카드를 불러오지 못했습니다.</Text>;
  if (!ownsDocument || !document) return <ActivityIndicator />;
  return (
    <WebView
      testID="task-board-custom-view"
      source={{ html: renderCustomViewHtml(document.html, bindings) }}
      originWhitelist={['about:blank', 'https://pages.eiaserinnys.me']}
      javaScriptEnabled
      allowFileAccess={false}
      scrollEnabled
      style={styles.customView}
    />
  );
}

function metadataText(item: BoardItem, key: string): string {
  const value = item.metadata?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function metadataNumber(item: BoardItem, key: string): number | undefined {
  const value = item.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function assetKind(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

function renderAssetMediaHtml(
  kind: Exclude<ReturnType<typeof assetKind>, 'file'>,
  url: string,
  title: string,
): string {
  const safeUrl = escapeAttribute(url);
  const safeTitle = escapeAttribute(title);
  const media = kind === 'image'
    ? `<img src="${safeUrl}" alt="${safeTitle}">`
    : `<${kind} src="${safeUrl}" controls preload="metadata"></${kind}>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline';"><style>html,body{margin:0;width:100%;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center}img,video{width:100%;height:100%;object-fit:contain}audio{width:94%}</style></head><body>${media}</body></html>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatByteSize(value: number | undefined): string {
  if (!value || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function makeStyles(t: DesignTokens) {
  const planner = createPlannerVisualRoles(t);
  return StyleSheet.create({
    group: { gap: t.spacing.sm },
    stateRow: {
      minHeight: planner.minHeight.context,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.cardLayout.padding,
      paddingVertical: t.uiSpacing.sm,
    },
    item: { padding: t.cardLayout.padding, gap: t.uiSpacing.sm },
    cardHeader: {
      minWidth: t.hitTarget.min,
      minHeight: planner.minHeight.row,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.uiSpacing.sm,
    },
    cardTitle: {
      flex: 1,
      color: t.colors.textPrimary,
      ...planner.typography.cardTitle,
    },
    iconFrame: {
      width: planner.contentIconFrame,
      height: planner.contentIconFrame,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconGlyph: { ...planner.typography.body },
    disclosureFrame: {
      width: planner.actionColumn,
      height: planner.actionColumn,
      alignItems: 'center',
      justifyContent: 'center',
    },
    assetOpenAction: {
      minWidth: planner.actionColumn,
      minHeight: planner.actionColumn,
      alignSelf: 'flex-end',
      alignItems: 'center',
      justifyContent: 'center',
    },
    assetTitle: { flex: 1, gap: t.uiSpacing.xxs },
    assetMeta: { color: t.colors.textTertiary, ...planner.typography.meta },
    assetMedia: { width: '100%', height: 220, backgroundColor: 'transparent' },
    openLabel: { color: t.colors.accent, ...planner.typography.label },
    body: { paddingTop: t.uiSpacing.sm },
    customView: { width: '100%', height: 420, backgroundColor: '#ffffff' },
    error: { color: t.colors.errorText, ...planner.typography.meta },
    empty: { color: t.colors.textTertiary, ...planner.typography.meta },
  });
}
