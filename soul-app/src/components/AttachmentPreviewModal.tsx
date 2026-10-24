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
import {
  attachmentMediaKind,
  attachmentMediaMimeType,
  attachmentContentUrl,
  isHtmlAttachmentView,
  isMarkdownAttachmentView,
  type AttachmentMediaKind,
  type AttachmentView,
} from '../lib/attachment-view';
import { captureAuthScope } from '../lib/auth-scope';
import { buildCustomViewBindings, renderDocumentHtml } from '../lib/custom-view-renderer';
import { LIGHT_COLORS } from '../theme/colors';
import { createSessionVisualRoles, useTokens } from '../theme';
import { GlassButton } from './GlassSurface';
import { AttachmentMetadataPreview } from './AttachmentMetadataPreview';
import { ImageViewerModal } from './ImageViewerModal';
import { PlannerMarkdownText } from './planner/PlannerMarkdownText';
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
  | { kind: 'markdown'; text: string; truncated: boolean }
  | { kind: 'html'; text: string; truncated: boolean }
  | { kind: 'empty' }
  | { kind: 'media'; mediaKind: AttachmentMediaKind; uri: string; mimeType: string | null }
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
  const layout = views.some(view => isHtmlAttachmentView(view) || isMarkdownAttachmentView(view)) ? 'document' : 'media';
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
  const markdown = !html && item.previewKind === 'text' && isMarkdownAttachmentView(item);
  const mediaKind = attachmentMediaKind(item);
  const [state, setState] = useState<PreviewState>(() => initialPreviewState(item));
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (textContent) {
      setState(html ? { kind: 'html', ...textContent }
        : markdown ? { kind: 'markdown', ...textContent } : { kind: 'text', ...textContent });
      return;
    }
    if (item.source.kind === 'unavailable') {
      setState(initialPreviewState(item));
      return;
    }
    if (mediaKind !== null) {
      const source = item.source;
      if (item.byteSize === 0) {
        setState({ kind: 'empty' });
        return;
      }
      if (source.previewUrl && /^(?:data:|blob:|file:)/i.test(source.previewUrl)) {
        setState({
          kind: 'media',
          mediaKind,
          uri: source.previewUrl,
          mimeType: attachmentMediaMimeType(item),
        });
        return;
      }

      const controller = new AbortController();
      const scope = captureAuthScope();
      const api = createApiClient(scope.serverUrl, { authScope: scope });
      let loadedUri: string | null = null;
      const releaseLoadedUri = () => {
        if (loadedUri?.startsWith('blob:') && loadedUri !== source.previewUrl
          && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(loadedUri);
        }
        loadedUri = null;
      };
      setState({ kind: 'loading' });
      const read = item.loadMedia
        ? item.loadMedia(controller.signal)
        : typeof api.readAttachmentMedia === 'function'
          ? api.readAttachmentMedia(source.attachmentId, item.readContext, controller.signal, {
            mimeType: item.mimeType,
            name: item.name,
          })
          : Promise.resolve({
            uri: attachmentContentUrl(source.attachmentId, item.readContext),
            mimeType: attachmentMediaMimeType(item),
          });
      void read
        .then(({ uri, mimeType }) => {
          loadedUri = uri;
          if (controller.signal.aborted) {
            releaseLoadedUri();
            return;
          }
          setState({ kind: 'media', mediaKind, uri, mimeType: mimeType ?? attachmentMediaMimeType(item) });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setState(readFailureState(error));
        });
      return () => {
        controller.abort();
        releaseLoadedUri();
      };
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
        if (!controller.signal.aborted) setState(html ? { kind: 'html', text, truncated }
          : markdown ? { kind: 'markdown', text, truncated } : { kind: 'text', text, truncated });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState(readFailureState(error));
      });
    return () => controller.abort();
  }, [item, retryKey, textContent, html, mediaKind]);

  const htmlDocument = useMemo(
    () => state.kind === 'html' ? renderDocumentHtml(state.text, CUSTOM_VIEW_BINDINGS) : null,
    [state],
  );
  // The document page uses the whole frame; text and states keep the padded, centered box.
  const fullBleed = (state.kind === 'html' && state.text.length > 0)
    || (state.kind === 'media' && state.mediaKind === 'video');
  const markdownDocument = state.kind === 'markdown' && state.text.length > 0;
  return <View style={{ flex: 1, width: '100%', ...(fullBleed ? null : {
    padding: t.spacing.md,
    ...(!markdownDocument ? { alignItems: 'center', justifyContent: 'center' } : null),
  }) }}>
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
    if (current.kind === 'empty') {
      return <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary }}>빈 파일</Text>;
    }
    if (current.kind === 'unavailable' || current.kind === 'failed') {
      return <View style={{ alignItems: 'center', gap: tokens.spacing.sm }}>
        <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary, textAlign: 'center' }}>{current.message}</Text>
        {current.kind === 'failed' && current.retryable ? <GlassButton size="card" onPress={() => setRetryKey((key) => key + 1)}>
          <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary }}>다시 시도</Text>
        </GlassButton> : null}
      </View>;
    }
    if (current.kind === 'media') {
      if (Platform.OS === 'web') {
        const tagName = current.mediaKind;
        const commonProps = {
          controls: true,
          preload: 'metadata' as const,
          src: current.uri,
          'aria-label': item.name,
          onError: () => setState({ kind: 'failed', message: '미리보기를 열 수 없습니다.', retryable: false }),
        };
        if (current.mediaKind === 'video') {
          return <View testID="attachment-preview-video" style={{
            flex: 1,
            width: '100%',
            height: '100%',
            alignItems: 'center',
            justifyContent: 'center',
          }}>{React.createElement(tagName, {
            ...commonProps,
            playsInline: true,
            style: { width: '100%', height: '100%', maxHeight: '100%', objectFit: 'contain', outline: 'none' },
          })}</View>;
        }
        return <View testID="attachment-preview-audio" style={{
          width: '100%',
          alignItems: 'center',
          justifyContent: 'center',
        }}>{React.createElement(tagName, {
          ...commonProps,
          style: { width: '100%', maxWidth: 420, outline: 'none' },
        })}</View>;
      }
      return <WebView
        testID={current.mediaKind === 'video' ? 'attachment-preview-video' : 'attachment-preview-audio'}
        source={{ html: buildMediaPreviewHtml(current.mediaKind, current.uri, current.mimeType, item.name) }}
        originWhitelist={['*']}
        javaScriptEnabled={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        scrollEnabled={false}
        style={{ flex: 1, width: '100%', backgroundColor: 'transparent' }}
      />;
    }
    if (current.text.length === 0) {
      return <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary }}>빈 파일</Text>;
    }
    if (current.kind === 'html') {
      return <>
        <WebView testID="attachment-preview-html" source={{ html: htmlDocument ?? '' }}
          originWhitelist={['about:blank', 'https://pages.eiaserinnys.me']} javaScriptEnabled allowFileAccess={false}
          scrollEnabled style={{ flex: 1, width: '100%', backgroundColor: LIGHT_COLORS.background }} />
        {current.truncated ? <Text style={{ ...roles.metadata, color: roles.textMuted, padding: tokens.spacing.sm }}>앞부분만 표시</Text> : null}
      </>;
    }
    if (current.kind === 'markdown') {
      return <ScrollView testID="attachment-preview-markdown" style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ gap: tokens.spacing.sm }}>
        <PlannerMarkdownText markdown={current.text} readContext={item.readContext} />
        {current.truncated ? <Text style={{ ...roles.metadata, color: roles.textMuted }}>앞부분만 표시</Text> : null}
      </ScrollView>;
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
  const mediaKind = attachmentMediaKind(item);
  if (mediaKind !== null) return item.byteSize === 0 ? { kind: 'empty' } : { kind: 'loading' };
  const html = isHtmlAttachmentView(item);
  const markdown = !html && item.previewKind === 'text' && isMarkdownAttachmentView(item);
  if (html || item.previewKind === 'text') {
    if (item.byteSize === 0) return html ? { kind: 'html', text: '', truncated: false }
      : markdown ? { kind: 'markdown', text: '', truncated: false } : { kind: 'text', text: '', truncated: false };
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

function buildMediaPreviewHtml(
  mediaKind: AttachmentMediaKind,
  uri: string,
  mimeType: string | null,
  name: string,
): string {
  const tag = mediaKind === 'video' ? 'video' : 'audio';
  const source = escapeHtmlAttribute(uri);
  const label = escapeHtmlAttribute(name);
  const mediaType = escapeHtmlAttribute(mimeType ?? '');
  const inlinePlayback = mediaKind === 'video' ? ' playsinline' : '';
  const sizeStyle = mediaKind === 'video'
    ? 'width:100%;height:100%;max-width:100%;object-fit:contain;'
    : 'width:100%;max-width:420px;max-height:100%;';
  return `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden}body{display:flex;align-items:center;justify-content:center}${tag}{${sizeStyle}}</style></head><body><${tag} controls${inlinePlayback} preload="metadata" src="${source}" aria-label="${label}" data-mime-type="${mediaType}"></${tag}></body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}
