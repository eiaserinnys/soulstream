import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { createApiClient } from '../api/client';
import { isHtmlAttachmentView, type AttachmentView } from '../lib/attachment-view';
import { captureAuthScope } from '../lib/auth-scope';
import { buildCustomViewBindings, renderCustomViewHtml } from '../lib/custom-view-renderer';
import { createSessionVisualRoles, useTokens } from '../theme';
import { GlassButton } from './GlassSurface';
import { AttachmentMetadataPreview } from './AttachmentMetadataPreview';
import { ImageViewerModal } from './ImageViewerModal';
import { attachmentImageSource } from '../lib/attachment-image-source';
import { WebView } from 'react-native-webview';

export type AttachmentOriginalSaveHandler = (
  view: AttachmentView,
  anchor?: number,
) => Promise<'shared' | 'cancelled' | void>;
export type AttachmentTextContent = { text: string; truncated: boolean };

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'html'; text: string; truncated: boolean }
  | { kind: 'info' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string; retryable: boolean };

const CUSTOM_VIEW_BINDINGS = buildCustomViewBindings(null, {});

export async function saveAttachmentOriginalView(
  view: AttachmentView,
  anchor?: number,
): Promise<'shared' | 'cancelled'> {
  const scope = captureAuthScope();
  if (Platform.OS === 'web') {
    const saver = await import('../lib/attachment-save.web');
    return saver.saveAttachmentOriginal({ view, scope });
  }
  const saver = await import('../lib/attachment-save.native');
  return saver.saveAttachmentOriginal({ view, scope, anchor });
}

export function AttachmentPreviewModal({ item, items = [item], initialIndex = 0, onClose, onSaveOriginal, textContent }: {
  item: AttachmentView;
  items?: readonly AttachmentView[];
  initialIndex?: number;
  onClose(): void;
  onSaveOriginal?: AttachmentOriginalSaveHandler;
  textContent?: AttachmentTextContent;
}) {
  const scope = captureAuthScope();
  const [resolved, setResolved] = useState<Record<string, AttachmentView>>({});
  const onResolved = useCallback((key: string, view: AttachmentView) => setResolved(previous => ({ ...previous, [key]: view })), []);
  const views = items.map(entry => resolved[entry.key] ?? entry);
  // A bundle that holds a readable document opens whole in the document layout so
  // paging never moves the header, close, save, or paging controls.
  const layout = views.some(isHtmlAttachmentView) ? 'document' : 'media';
  return <View testID="attachment-preview-modal">
    <ImageViewerModal variant="chatRefined" layout={layout} items={views} initialIndex={initialIndex} onClose={onClose}
      sources={views.map(entry => entry.previewKind === 'image' && entry.source.kind === 'ready'
        ? attachmentImageSource({ ...entry, source: entry.source }, scope.serverUrl, scope.jwt) : {})}
      renderAttachment={(entry) => entry.loadMetadata ? <AttachmentMetadataPreview key={entry.key} item={entry} onResolved={onResolved} /> : <AttachmentPreviewContent key={entry.key} item={entry}
        {...(entry.key === item.key && textContent ? { textContent } : {})} />}
      onSaveOriginal={async (index, anchor) => { await (onSaveOriginal ?? saveAttachmentOriginalView)(views[index], anchor); }} />
  </View>;
}

function AttachmentPreviewContent({ item, textContent }: { item: AttachmentView; textContent?: AttachmentTextContent }) {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const html = isHtmlAttachmentView(item);
  const [state, setState] = useState<PreviewState>(() => initialPreviewState(item));
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (textContent) {
      setState({ kind: 'text', ...textContent });
      return;
    }
    if ((!html && item.previewKind !== 'text') || item.source.kind !== 'ready' || item.byteSize === 0) {
      setState(initialPreviewState(item));
      return;
    }
    const controller = new AbortController();
    const scope = captureAuthScope();
    const source = item.source;
    setState({ kind: 'loading' });
    const read = item.loadText
      ? item.loadText(controller.signal)
      : createApiClient(scope.serverUrl, { authScope: scope })
        .readAttachmentText(source.attachmentId, item.readContext, controller.signal);
    void read
      .then(({ text, truncated }) => {
        if (!controller.signal.aborted) setState(html ? { kind: 'html', text, truncated } : { kind: 'text', text, truncated });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState(readFailureState(error));
      });
    return () => controller.abort();
  }, [item, retryKey, textContent, html]);

  const htmlDocument = useMemo(
    () => state.kind === 'html' ? renderCustomViewHtml(state.text, CUSTOM_VIEW_BINDINGS) : null,
    [state],
  );
  // The document page uses the whole frame; text and states keep the padded, centered box.
  const fullBleed = state.kind === 'html' && state.text.length > 0;
  return <View style={{ flex: 1, width: '100%', ...(fullBleed ? null : { padding: t.spacing.md, alignItems: 'center', justifyContent: 'center' }) }}>
    {renderPreviewState(state, t, attachment)}
  </View>;

  function renderPreviewState(current: PreviewState, tokens: ReturnType<typeof useTokens>, roles: ReturnType<typeof createSessionVisualRoles>['chat']['attachment']) {
    if (current.kind === 'loading') return <ActivityIndicator color={tokens.colors.accent} />;
    if (current.kind === 'info') {
      return <View accessibilityLabel={`${fileExtension(item.name)} 파일`} style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Ionicons name="document-outline" size={tokens.foundation.iconFrame.standard} color={roles.textMuted} />
        <Text style={{ ...tokens.foundation.typography.meta, color: roles.textMuted }}>{fileExtension(item.name)}</Text>
      </View>;
    }
    if (current.kind === 'unavailable' || current.kind === 'failed') {
      return <View style={{ alignItems: 'center', gap: tokens.spacing.sm }}>
        <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary, textAlign: 'center' }}>{current.message}</Text>
        {current.kind === 'failed' && current.retryable ? <GlassButton size="card" onPress={() => setRetryKey((key) => key + 1)}>
          <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary }}>다시 시도</Text>
        </GlassButton> : null}
      </View>;
    }
    if (current.text.length === 0) {
      return <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary }}>빈 파일</Text>;
    }
    if (current.kind === 'html') {
      return <>
        <WebView testID="attachment-preview-html" source={{ html: htmlDocument ?? '' }}
          originWhitelist={['about:blank', 'https://pages.eiaserinnys.me']} javaScriptEnabled allowFileAccess={false}
          scrollEnabled style={{ flex: 1, width: '100%', backgroundColor: tokens.colors.surfaceCode }} />
        {current.truncated ? <Text style={{ ...roles.metadata, color: roles.textMuted, padding: tokens.spacing.sm }}>앞부분만 표시</Text> : null}
      </>;
    }
    return <ScrollView testID="attachment-preview-text" style={{ flex: 1, width: '100%' }} contentContainerStyle={{ gap: tokens.spacing.sm }}>
      <Text selectable style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary }}>{current.text}</Text>
      {current.truncated ? <Text style={{ ...roles.metadata, color: roles.textMuted }}>앞부분만 표시</Text> : null}
    </ScrollView>;
  }
}

function initialPreviewState(item: AttachmentView): PreviewState {
  if (item.source.kind === 'unavailable') {
    const message = item.source.availability === 'missing' ? '찾을 수 없음'
      : item.source.availability === 'unavailable' ? '사용할 수 없음' : '첨부 정보를 확인할 수 없음';
    return { kind: 'unavailable', message };
  }
  const html = isHtmlAttachmentView(item);
  if (html || item.previewKind === 'text') {
    if (item.byteSize === 0) return html ? { kind: 'html', text: '', truncated: false } : { kind: 'text', text: '', truncated: false };
    return { kind: 'loading' };
  }
  return { kind: 'info' };
}

function readFailureState(error: unknown): PreviewState {
  const kind = typeof error === 'object' && error !== null && 'kind' in error
    ? (error as { kind?: string }).kind : undefined;
  if (kind === 'denied') return { kind: 'failed', message: '접근 권한이 없습니다.', retryable: false };
  if (kind === 'not-found') return { kind: 'failed', message: '찾을 수 없음', retryable: false };
  if (kind === 'unauthorized') return { kind: 'failed', message: '로그인이 필요합니다.', retryable: false };
  if (kind === 'conflict') return { kind: 'failed', message: '요청을 확인할 수 없습니다.', retryable: false };
  if (kind === 'retryable') return { kind: 'failed', message: '미리보기를 불러오지 못했습니다.', retryable: true };
  return { kind: 'failed', message: '미리보기를 열 수 없습니다.', retryable: false };
}

function fileExtension(name: string): string {
  const extension = name.split('.').pop() ?? '';
  return extension && extension !== name ? extension.toUpperCase() : '';
}
