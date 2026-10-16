import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  findNodeHandle,
  Modal,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { createApiClient } from '../api/client';
import type { AttachmentView } from '../lib/attachment-view';
import { captureAuthScope } from '../lib/auth-scope';
import { formatAttachmentByteSize } from './AttachmentFileRow';
import { createSessionVisualRoles, useTokens } from '../theme';
import { MODAL_BACKDROP_COLOR } from '../theme/surfaceRoles';
import { GlassButton, GlassSurface } from './GlassSurface';

export type AttachmentOriginalSaveHandler = (
  view: AttachmentView,
  anchor?: number,
) => Promise<'shared' | 'cancelled' | void>;

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

export function AttachmentPreviewModal({ item, onClose, onSaveOriginal }: {
  item: AttachmentView;
  onClose(): void;
  onSaveOriginal?: AttachmentOriginalSaveHandler;
}) {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const saveAnchorRef = useRef<View | null>(null);
  const [state, setState] = useState<PreviewState>(() => initialPreviewState(item));
  const [retryKey, setRetryKey] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (item.previewKind !== 'text' || item.source.kind !== 'ready') {
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
  }, [item, retryKey]);

  const save = async () => {
    setSaveError(null);
    const anchor = Platform.OS === 'ios' ? findNodeHandle(saveAnchorRef.current) ?? undefined : undefined;
    try {
      await (onSaveOriginal ?? saveAttachmentOriginalView)(item, anchor);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : '원본을 저장하지 못했습니다.');
    }
  };

  const canSave = item.source.kind === 'ready';
  const size = formatAttachmentByteSize(item.byteSize);

  return <Modal visible transparent presentationStyle="overFullScreen" onRequestClose={onClose}>
    <SafeAreaProvider>
      <SafeAreaView testID="attachment-preview-modal" style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: t.spacing.md,
        backgroundColor: MODAL_BACKDROP_COLOR,
      }}>
        <GlassSurface role="modal" style={{ width: '100%', maxHeight: '90%', overflow: 'hidden' }}>
          <View style={{ padding: t.spacing.md, gap: t.spacing.md }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} ellipsizeMode="tail" style={{
                  ...t.foundation.typography.cardTitle,
                  color: t.colors.textPrimary,
                }}>{item.name}</Text>
                {size ? <Text style={{ ...attachment.metadata, color: attachment.textMuted }}>{size}</Text> : null}
              </View>
              <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
                accessibilityLabel="첨부 미리보기 닫기" testID="attachment-preview-close" onPress={onClose}>
                <Ionicons name="close" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
              </GlassButton>
            </View>
            <View style={{
              flex: 1,
              minHeight: t.foundation.minHeight.secondary,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: attachment.radius,
              backgroundColor: attachment.surface,
              padding: t.spacing.md,
            }}>
              {renderPreviewState(state, t, attachment)}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.md }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                {saveError ? <Text style={{ ...attachment.metadata, color: t.colors.textMuted }}>{saveError}</Text> : null}
              </View>
              {canSave ? <View ref={saveAnchorRef} collapsable={false}>
                <GlassButton size="card" accessibilityLabel="원본 저장" testID="attachment-preview-save-original" onPress={() => { void save(); }}>
                  <Ionicons name="download-outline" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
                  <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>원본 저장</Text>
                </GlassButton>
              </View> : null}
            </View>
          </View>
        </GlassSurface>
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;

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
    return <ScrollView style={{ width: '100%' }} contentContainerStyle={{ gap: tokens.spacing.sm }}>
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
  return item.previewKind === 'text' ? { kind: 'loading' } : { kind: 'info' };
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
