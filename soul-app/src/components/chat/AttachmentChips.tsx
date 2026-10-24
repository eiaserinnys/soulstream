import React, { useEffect, useRef, useState } from 'react';
import { File } from 'expo-file-system';
import { Platform, Share, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ChatAttachment } from '../../hooks/useChatAttachments';
import type { ChatBodyStyles } from './ChatBody.styles';
import { DESIGN_ICON_SIZE } from '../../theme';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { useTokens } from '../../theme';
import { getChatRowHorizontalInset } from './ChatBody.styles';
import { createApiRequestContext } from '../../api/clientCore';
import { createAttachmentEndpoints } from '../../api/attachmentEndpoints';
import type { AttachmentReadContext } from '../../../../packages/wire-schema/src/attachments';
import {
  MAX_ATTACHMENT_TEXT_BYTES,
  attachmentMediaKind,
  isHtmlAttachmentView,
  type AttachmentView,
} from '../../lib/attachment-view';
import { captureAuthScope, isAuthScopeCurrent } from '../../lib/auth-scope';
import { AttachmentPreviewModal, type AttachmentTextContent } from '../AttachmentPreviewModal';

interface Props {
  attachments: ChatAttachment[];
  styles: ChatBodyStyles;
  textSecondaryColor: string;
  textMutedColor: string;
  onRemove: (index: number) => void;
  readOnly?: boolean;
  disabled?: boolean;
  presentation?: 'default' | 'manuscript';
  containerStyle?: StyleProp<ViewStyle>;
  trailingAccessory?: React.ReactNode;
  previewEnabled?: boolean;
  previewNodeId?: string;
}

export function AttachmentChips({
  attachments,
  styles,
  textSecondaryColor,
  textMutedColor,
  onRemove,
  readOnly = false,
  disabled = false,
  presentation = 'default',
  containerStyle,
  trailingAccessory,
  previewEnabled = false,
  previewNodeId,
}: Props) {
  const t = useTokens();
  const [preview, setPreview] = useState<{ item: AttachmentView; textContent?: AttachmentTextContent; localUri?: string } | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const previewGeneration = useRef(0);
  useEffect(() => () => {
    previewGeneration.current += 1;
    previewRequest.current?.abort();
  }, []);
  if (attachments.length === 0) return null;

  const openPreview = async (attachment: ChatAttachment) => {
    previewRequest.current?.abort();
    const requestId = ++previewGeneration.current;
    const controller = new AbortController();
    previewRequest.current = controller;
    const scope = captureAuthScope();
    try {
      const result = attachment.originalFile?.uri
        ? await readLocalAttachment(attachment, scope, controller.signal)
        : await readOwnedPathAttachment(attachment, previewNodeId, scope, controller.signal);
      if (previewGeneration.current !== requestId || controller.signal.aborted || !isAuthScopeCurrent(scope)) return;
      setPreview(result);
    } catch {
      if (previewGeneration.current !== requestId || controller.signal.aborted || !isAuthScopeCurrent(scope)) return;
      setPreview({ item: unavailablePendingAttachment(attachment, attachment.nodeId || previewNodeId) });
    }
  };

  const renderAttachment = (
    attachment: ChatAttachment,
    idx: number,
    frameStyle?: StyleProp<ViewStyle>,
  ) => {
    const chipStyle = presentation === 'manuscript'
      ? [styles.attachmentChip, {
          backgroundColor: t.persistentSession.paper,
          borderColor: t.persistentSession.line,
          borderWidth: StyleSheet.hairlineWidth,
        }]
      : styles.attachmentChip;
    const canPreview = previewEnabled && !readOnly && (attachment.path.length > 0 || Boolean(attachment.originalFile?.uri));
    const chipContents = <>
        <Ionicons
          name="document-outline"
          color={textSecondaryColor}
          size={DESIGN_ICON_SIZE.compact}
        />
        <Text style={styles.attachmentName} numberOfLines={1}>
          {attachment.name}
        </Text>
        {!readOnly ? <View style={styles.attachmentRemoveSpacer} /> : null}
    </>;
    return (
      <View key={`${attachment.path}-${idx}`} style={[readOnly ? {
        height: t.controlHeight.chip,
        maxWidth: '100%',
        justifyContent: 'center',
      } : styles.attachmentTouchFrame, frameStyle]}>
      {canPreview ? <CompactTouchTarget
        testID={`chat-attachment-preview-${idx}`}
        accessibilityRole="button"
        accessibilityLabel={`${attachment.name} 미리보기`}
        onPress={() => { void openPreview(attachment); }}
        surfaceStyle={chipStyle}
      >{chipContents}</CompactTouchTarget> : <View style={chipStyle}>{chipContents}</View>}
      {!readOnly ? (
        <CompactTouchTarget
          testID={`chat-attachment-remove-${idx}`}
          onPress={() => onRemove(idx)}
          disabled={disabled}
          accessibilityState={{ disabled }}
          accessibilityLabel={`${attachment.name} 첨부 제거`}
          frameStyle={styles.attachmentRemoveFrame}
          surfaceStyle={styles.attachmentRemove}
        >
          <Ionicons name="close" color={textMutedColor} size={DESIGN_ICON_SIZE.standard} />
        </CompactTouchTarget>
      ) : null}
      </View>
    );
  };
  const hasTrailingAccessory = trailingAccessory !== undefined && trailingAccessory !== null;
  const baseContainerStyle = containerStyle ?? (presentation === 'manuscript'
    ? [styles.attachmentRow, { paddingHorizontal: getChatRowHorizontalInset(t, presentation) }]
    : styles.attachmentRow);

  return (
    <>
    <View style={hasTrailingAccessory ? [baseContainerStyle, { alignItems: 'center' }] : baseContainerStyle}>
      {hasTrailingAccessory ? (
        <>
          {attachments.slice(0, -1).map((attachment, idx) => renderAttachment(attachment, idx))}
          <View style={styles.generatedAttachmentActionRow}>
            {renderAttachment(attachments[attachments.length - 1], attachments.length - 1,
              { flexShrink: 1, minWidth: 0, maxWidth: '100%' },
            )}
            <View style={{ marginLeft: 'auto', flexShrink: 0 }}>{trailingAccessory}</View>
          </View>
        </>
      ) : attachments.map((attachment, idx) => renderAttachment(attachment, idx))}
    </View>
    {preview ? <AttachmentPreviewModal
      item={preview.item}
      onClose={() => {
        previewGeneration.current += 1;
        previewRequest.current?.abort();
        setPreview(null);
      }}
      {...(preview.textContent ? { textContent: preview.textContent } : {})}
      {...(preview.localUri ? { onSaveOriginal: saveLocalAttachmentOriginal } : {})}
    /> : null}
    </>
  );
}

const OWNER_CONTEXT: AttachmentReadContext = { type: 'owner' };

async function readLocalAttachment(
  attachment: ChatAttachment,
  scope: ReturnType<typeof captureAuthScope>,
  signal: AbortSignal,
): Promise<{ item: AttachmentView; textContent?: AttachmentTextContent; localUri: string }> {
  const file = attachment.originalFile!;
  const localFile = new File(file.uri);
  const byteSize = safeFileSize(localFile.size);
  const mimeType = file.type || localFile.type || attachment.mimeType || null;
  const name = file.name || attachment.name;
  const previewKind = previewKindFor(mimeType, name, true);
  const isHtml = isHtmlAttachmentView({ mimeType, name });
  const item: AttachmentView = {
    key: `local:${file.uri}`,
    name,
    mimeType,
    byteSize,
    previewKind,
    readContext: OWNER_CONTEXT,
    source: {
      kind: 'ready',
      attachmentId: `local:${file.uri}`,
      previewUrl: file.uri,
      originalUrl: file.uri,
    },
  };
  if (previewKind !== 'text' && !isHtml) return { item, localUri: file.uri };
  try {
    const textContent = await readLocalText(localFile, byteSize, signal);
    if (!isAuthScopeCurrent(scope)) throw new Error('Attachment preview scope changed');
    return { item, textContent, localUri: file.uri };
  } catch {
    return { item: { ...item, source: { kind: 'unavailable', availability: 'unavailable' } }, localUri: file.uri };
  }
}

async function readLocalText(file: File, byteSize: number | null, signal: AbortSignal): Promise<AttachmentTextContent> {
  if (signal.aborted) throw new Error('Attachment preview aborted');
  const size = byteSize ?? file.size;
  if (size === 0) return { text: '', truncated: false };
  const maximumRead = Math.min(Number.isSafeInteger(size) ? size : MAX_ATTACHMENT_TEXT_BYTES + 1,
    MAX_ATTACHMENT_TEXT_BYTES + 1);
  const handle = file.open();
  try {
    const bytes = handle.readBytes(maximumRead);
    if (signal.aborted) throw new Error('Attachment preview aborted');
    const truncated = bytes.byteLength > MAX_ATTACHMENT_TEXT_BYTES || size > MAX_ATTACHMENT_TEXT_BYTES;
    const decoder = new TextDecoder('utf-8');
    return {
      text: decoder.decode(bytes.subarray(0, MAX_ATTACHMENT_TEXT_BYTES), truncated ? { stream: true } : undefined),
      truncated,
    };
  } finally {
    handle.close();
  }
}

async function readOwnedPathAttachment(
  attachment: ChatAttachment,
  fallbackNodeId: string | undefined,
  scope: ReturnType<typeof captureAuthScope>,
  signal: AbortSignal,
): Promise<{ item: AttachmentView }> {
  const nodeId = attachment.nodeId || fallbackNodeId;
  if (!nodeId || !attachment.path || !scope.serverUrl) {
    return { item: unavailablePendingAttachment(attachment, nodeId) };
  }

  const api = createApiRequestContext(scope.serverUrl, { authScope: scope });
  const url = new URL(`${api.base}/api/attachments/files`);
  url.searchParams.set('nodeId', nodeId);
  url.searchParams.set('path', attachment.path);
  const response = await api.authFetch(url.href, { method: 'HEAD', signal });
  if (!response.ok) return { item: unavailablePendingAttachment(attachment, nodeId) };

  const name = filenameFromContentDisposition(response.headers.get('content-disposition')) || attachment.name;
  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim() || attachment.mimeType || null;
  const id = response.headers.get('x-attachment-id');
  const originalUrl = new URL(url.href);
  originalUrl.searchParams.set('download', 'true');
  const item: AttachmentView = {
    key: id || `${nodeId}:${attachment.path}`,
    name,
    mimeType,
    byteSize: null,
    previewKind: previewKindFor(mimeType, name, Boolean(id)),
    readContext: OWNER_CONTEXT,
    source: {
      kind: 'ready',
      attachmentId: id || `${nodeId}:${attachment.path}`,
      previewUrl: url.href,
      originalUrl: originalUrl.href,
    },
  };
  if (!id) {
    const endpoints = createAttachmentEndpoints(api);
    if (isHtmlAttachmentView(item)) {
      item.loadText = (textSignal) => endpoints.readLegacyAttachmentText(url.href, textSignal);
    }
    if (attachmentMediaKind(item) !== null) {
      item.loadMedia = (mediaSignal) => endpoints.readLegacyAttachmentMedia(url.href, mediaSignal, {
        mimeType: item.mimeType,
        name: item.name,
      });
    }
  }
  return { item };
}

function unavailablePendingAttachment(attachment: ChatAttachment, nodeId?: string): AttachmentView {
  return {
    key: attachment.path || attachment.originalFile?.uri || `pending:${attachment.name}`,
    name: attachment.name,
    mimeType: attachment.mimeType || null,
    byteSize: null,
    previewKind: previewKindFor(attachment.mimeType || null, attachment.name, false),
    readContext: OWNER_CONTEXT,
    source: { kind: 'unavailable', availability: nodeId ? 'unavailable' : 'unresolved' },
  };
}

function previewKindFor(mimeType: string | null, name: string, idBacked: boolean): AttachmentView['previewKind'] {
  if (/\.svg$/i.test(name)) return 'info';
  if (/\.(?:png|jpe?g|gif|webp|heic|avif)$/i.test(name)) return 'image';
  if (idBacked && (mimeType?.startsWith('text/') || /\.(?:txt|md|json)$/i.test(name))) return 'text';
  return 'info';
}

function safeFileSize(size: number | null): number | null {
  return Number.isSafeInteger(size) && (size ?? -1) >= 0 ? size : null;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]?.trim();
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch { return null; }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return (plain?.[1] ?? plain?.[2])?.trim() || null;
}

async function saveLocalAttachmentOriginal(view: AttachmentView, anchor?: number): Promise<'shared' | 'cancelled'> {
  if (view.source.kind !== 'ready' || !view.source.originalUrl) return 'cancelled';
  try {
    if (Platform.OS === 'web') {
      window.open(view.source.originalUrl, '_blank', 'noopener,noreferrer');
      return 'shared';
    }
    const result = await Share.share({ url: view.source.originalUrl }, anchor === undefined ? undefined : { anchor });
    return result.action === Share.sharedAction ? 'shared' : 'cancelled';
  } catch {
    return 'cancelled';
  }
}
