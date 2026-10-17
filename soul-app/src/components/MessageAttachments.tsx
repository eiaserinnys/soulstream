import React, { useMemo, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { captureAuthScope } from '../lib/auth-scope';
import type { AttachmentView } from '../lib/attachment-view';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import { AttachmentFileRow } from './AttachmentFileRow';
import { ChatRefinedImageGallery, type ChatRefinedGalleryItem } from './AttachmentImage';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import { attachmentImageSource } from '../lib/attachment-image-source';
import type { MessageAttachmentFailure } from '../hooks/useMessageAttachments';
import { GlassButton } from './GlassSurface';

export function MessageAttachments({ items, role, presentation = 'default', captionColor, loading, failure, onRetry }: {
  items: readonly AttachmentView[];
  role: 'assistant' | 'user';
  presentation?: 'default' | 'manuscript';
  captionColor?: string;
  loading?: boolean;
  failure?: MessageAttachmentFailure | null;
  onRetry?(): void;
}) {
  const t = useTokens();
  const device = useDeviceType();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const restoreFocus = useRef<(() => void) | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const authScope = captureAuthScope();
  const images = useMemo(() => items.filter((item): item is AttachmentView & {
    previewKind: 'image'; source: Extract<AttachmentView['source'], { kind: 'ready' }>;
  } => item.previewKind === 'image' && item.source.kind === 'ready'), [items]);
  const fileRows = useMemo(() => items.filter((item) => item.previewKind !== 'image' || item.source.kind !== 'ready'), [items]);
  const galleryImages: ChatRefinedGalleryItem[] = images.map((item) => ({
    source: attachmentImageSource(item, authScope.serverUrl, authScope.jwt),
    filename: item.name,
    alt: item.name,
    mimeType: item.mimeType ?? undefined,
    byteSize: item.byteSize ?? undefined,
  }));
  const maxWidth = role === 'user'
    ? attachment.userMaxWidth
    : device === 'phone' ? attachment.phoneAssistantMaxWidth : attachment.assistantMaxWidth;

  const open = (index: number, restore: () => void) => {
    restoreFocus.current = restore;
    setSelectedIndex(index);
  };
  const close = () => {
    setSelectedIndex(null);
    restoreFocus.current?.();
  };

  if (items.length === 0 && !loading && !failure) return null;
  return <View testID="message-attachments" style={{ width: '100%', gap: attachment.gridGap }}>
    {failure || (loading && items.length === 0) ? <View testID="message-attachment-read-status" style={{ gap: attachment.gridGap }}>
      <Text lineBreakStrategyIOS="hangul-word" style={{ ...attachment.metadata,
        ...(Platform.OS === 'web' ? { wordBreak: 'keep-all' as const } : {}),
        color: captionColor ?? t.colors.textPrimary }}>{failure?.message ?? '불러오는 중…'}</Text>
      {failure?.retryable && onRetry ? <GlassButton size="card" accessibilityLabel="첨부 다시 시도" onPress={onRetry}>
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>다시 시도</Text>
      </GlassButton> : null}
    </View> : null}
    {images.length > 0 ? <ChatRefinedImageGallery
      images={galleryImages}
      role={role}
      testID="message-attachments-images"
      embedded
      captionColor={captionColor}
      onOpenImage={(index, restore) => open(items.indexOf(images[index]), restore)}
    /> : null}
    {fileRows.length > 0 ? <View testID="message-attachments-file-rows" style={{
      width: '100%',
      maxWidth,
      alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
      gap: attachment.gridGap,
    }}>
      {fileRows.map((item, index) => <AttachmentFileRow
        key={item.key}
        item={item}
        presentation={presentation}
        testID={`message-attachment-row-${index}`}
        onPress={(restore) => open(items.indexOf(item), restore)}
      />)}
    </View> : null}
    {selectedIndex !== null ? <AttachmentPreviewModal item={items[selectedIndex]} items={items}
      initialIndex={selectedIndex} onClose={close} /> : null}
  </View>;
}
