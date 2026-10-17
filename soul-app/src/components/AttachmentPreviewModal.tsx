import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { createApiClient } from '../api/client';
import type { AttachmentView } from '../lib/attachment-view';
import { captureAuthScope } from '../lib/auth-scope';
import { createSessionVisualRoles, useTokens } from '../theme';
import { GlassButton } from './GlassSurface';
import { AttachmentMetadataPreview } from './AttachmentMetadataPreview';
import { ImageViewerModal } from './ImageViewerModal';
import { attachmentImageSource } from '../lib/attachment-image-source';

export type AttachmentOriginalSaveHandler = (
  view: AttachmentView,
  anchor?: number,
) => Promise<'shared' | 'cancelled' | void>;
export type AttachmentTextContent = { text: string; truncated: boolean };

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'info' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'failed'; message: string; retryable: boolean };

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
  return <View testID="attachment-preview-modal">
    <ImageViewerModal variant="chatRefined" items={views} initialIndex={initialIndex} onClose={onClose}
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
  const [state, setState] = useState<PreviewState>(() => initialPreviewState(item));
  const [retryKey, setRetryKey] = useState(0);
  useEffect(() => {
    if (textContent) {
      setState({ kind: 'text', ...textContent });
      return;
    }
    if (item.previewKind !== 'text' || item.source.kind !== 'ready' || item.byteSize === 0) {
      setState(initialPreviewState(item));
      return;
    }
    const controller = new AbortController();
    const scope = captureAuthScope();
    setState({ kind: 'loading' });
    void createApiClient(scope.serverUrl, { authScope: scope })
      .readAttachmentText(item.source.attachmentId, item.readContext, controller.signal)
      .then(({ text, truncated }) => {
        if (!controller.signal.aborted) setState({ kind: 'text', text, truncated });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState(readFailureState(error));
      });
    return () => controller.abort();
  }, [item, retryKey, textContent]);

  return <View style={{ flex: 1, width: '100%', padding: t.spacing.md, alignItems: 'center', justifyContent: 'center' }}>
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
  return item.previewKind === 'text'
    ? item.byteSize === 0 ? { kind: 'text', text: '', truncated: false } : { kind: 'loading' }
    : { kind: 'info' };
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
