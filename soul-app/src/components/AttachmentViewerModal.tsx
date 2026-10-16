import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ImageViewerModalProps } from './ImageViewerModal';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import { MODAL_BACKDROP_COLOR } from '../theme/surfaceRoles';
import { GlassButton, GlassSurface } from './GlassSurface';
import { ImageViewerPages } from './ImageViewerPages';
import { AttachmentViewerFooter } from './AttachmentViewerFooter';
import { formatAttachmentByteSize } from './AttachmentFileRow';

export function AttachmentViewerModal(props: ImageViewerModalProps) {
  const t = useTokens();
  return <Modal visible transparent presentationStyle="overFullScreen" onRequestClose={props.onClose}>
    <SafeAreaProvider>
      <View testID="chat-image-viewer-viewport" style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="미리보기 배경 닫기"
          testID="chat-image-viewer-backdrop"
          style={[StyleSheet.absoluteFill, { minWidth: t.hitTarget.min, minHeight: t.hitTarget.min }]}
          onPress={props.onClose}
        />
        <ChatRefinedImageViewerContent {...props} />
      </View>
    </SafeAreaProvider>
  </Modal>;
}

function ChatRefinedImageViewerContent({
  sources,
  initialIndex,
  onClose,
  filenames,
  items,
  onSaveOriginal,
  byteSizes,
  renderAttachment,
}: ImageViewerModalProps) {
  const t = useTokens();
  const device = useDeviceType();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const [currentIndex, setCurrentIndex] = useState(clampIndex(initialIndex, sources.length));
  const filename = filenames?.[currentIndex] ?? items?.[currentIndex]?.name ?? '';
  const size = formatAttachmentByteSize(items?.[currentIndex]?.byteSize ?? byteSizes?.[currentIndex] ?? null);

  return <SafeAreaView testID="chat-image-viewer-content" pointerEvents="box-none" edges={['top', 'bottom', 'left', 'right']} style={{
      flex: 1,
      backgroundColor: MODAL_BACKDROP_COLOR,
      justifyContent: 'center',
      alignItems: 'center',
      padding: t.spacing.md,
    }}>
      <GlassSurface role="modal" testID="chat-image-viewer-surface" style={{
        width: '100%',
        maxHeight: '90%',
        overflow: 'hidden',
      }}>
        <View style={{ padding: t.spacing.md, gap: t.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {filename ? <Text numberOfLines={1} ellipsizeMode="tail" style={{
                ...t.foundation.typography.body,
                color: t.colors.textPrimary,
              }}>{filename}</Text> : null}
              {size ? <Text style={{ ...attachment.metadata, color: attachment.textMuted }}>{size}</Text> : null}
            </View>
            <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
              accessibilityLabel="첨부 미리보기 닫기" testID="chat-image-viewer-close" onPress={onClose}>
              <Ionicons name="close" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
            </GlassButton>
          </View>
          <View testID="chat-image-viewer-frame" style={{
            height: (window.height - insets.top - insets.bottom) * (device === 'phone' ? 0.46 : 0.58),
            minHeight: t.foundation.minHeight.secondary,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            borderRadius: attachment.radius,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: attachment.border,
            backgroundColor: attachment.surface,
          }}>
            <ImageViewerPages sources={sources} items={items} currentIndex={currentIndex}
              onIndexChange={setCurrentIndex} style={{ width: '100%', height: '100%' }}
              activeImageTestID="chat-image-viewer-image" renderAttachment={renderAttachment} />
          </View>
          <AttachmentViewerFooter count={sources.length} currentIndex={currentIndex}
            onIndexChange={setCurrentIndex} onSaveOriginal={onSaveOriginal && (!items || items[currentIndex]?.source.kind === 'ready') ? onSaveOriginal : undefined} />
        </View>
      </GlassSurface>
    </SafeAreaView>;
}

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(0, count - 1));
}
