import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useRef, useState } from 'react';
import {
  findNodeHandle,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AttachmentView } from '../lib/attachment-view';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import { MODAL_BACKDROP_COLOR } from '../theme/surfaceRoles';
import { GlassButton, GlassSurface } from './GlassSurface';
import { ImageViewerPages } from './ImageViewerPages';

export type ImageViewerModalProps = {
  captions?: readonly string[];
  sources: ImageSourcePropType[];
  initialIndex: number;
  onClose(): void;
  variant?: 'default' | 'chatRefined';
  filenames?: readonly string[];
  alts?: readonly string[];
  metadataLabels?: readonly string[];
  items?: readonly AttachmentView[];
  onSaveOriginal?(index: number, anchor?: number): Promise<void>;
};

export function ImageViewerModal(props: ImageViewerModalProps) {
  return props.variant === 'chatRefined'
    ? <ChatRefinedImageViewerModal {...props} />
    : <DefaultImageViewerModal {...props} />;
}

function DefaultImageViewerModal({ sources, initialIndex, onClose, captions, items, onSaveOriginal }: ImageViewerModalProps) {
  const t = useTokens();
  const [currentIndex, setCurrentIndex] = useState(clampIndex(initialIndex, sources.length));
  const viewerCaptions = captions ?? items?.map((item) => item.name);
  return <Modal visible transparent presentationStyle="overFullScreen" onRequestClose={onClose}>
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: MODAL_BACKDROP_COLOR }}>
        <View style={{ alignItems: 'flex-end', padding: t.spacing.md }}>
          <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round} accessibilityLabel="이미지 닫기" onPress={onClose}>
            <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>×</Text>
          </GlassButton>
        </View>
        <View style={{ flex: 1, marginVertical: t.spacing.md }}>
          <ImageViewerPages sources={sources} items={items} captions={viewerCaptions} currentIndex={currentIndex}
            onIndexChange={setCurrentIndex} style={{ flex: 1, marginVertical: t.spacing.md }} />
        </View>
        <ImageViewerFooter sources={sources} items={items} currentIndex={currentIndex}
          onIndexChange={setCurrentIndex} onSaveOriginal={onSaveOriginal} />
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

function ChatRefinedImageViewerModal(props: ImageViewerModalProps) {
  const t = useTokens();
  return <Modal visible transparent presentationStyle="overFullScreen" onRequestClose={props.onClose}>
    <SafeAreaProvider>
      <View testID="chat-image-viewer-viewport" style={{ flex: 1 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="이미지 미리보기 닫기"
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
  alts,
  items,
  onSaveOriginal,
}: ImageViewerModalProps) {
  const t = useTokens();
  const device = useDeviceType();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const [currentIndex, setCurrentIndex] = useState(clampIndex(initialIndex, sources.length));
  const filename = filenames?.[currentIndex] ?? items?.[currentIndex]?.name ?? '';
  const alt = alts?.[currentIndex] ?? filename;

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
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: t.spacing.md }}>
            <View style={{ flex: 1, minWidth: 0, paddingTop: t.spacing.xs }}>
              {filename ? <Text numberOfLines={1} ellipsizeMode="tail" style={{
                ...attachment.metadata,
                color: attachment.textMuted,
              }}>{filename}</Text> : null}
            </View>
            <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
              accessibilityLabel="이미지 미리보기 닫기" testID="chat-image-viewer-close" onPress={onClose}>
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
              activeImageTestID="chat-image-viewer-image" />
          </View>
          <ImageViewerFooter sources={sources} items={items} currentIndex={currentIndex}
            onIndexChange={setCurrentIndex} onSaveOriginal={onSaveOriginal} />
        </View>
      </GlassSurface>
    </SafeAreaView>;
}

function ImageViewerFooter({ sources, items, currentIndex, onIndexChange, onSaveOriginal }: {
  sources: readonly ImageSourcePropType[];
  items?: readonly AttachmentView[];
  currentIndex: number;
  onIndexChange(index: number): void;
  onSaveOriginal?: (index: number, anchor?: number) => Promise<void>;
}) {
  const t = useTokens();
  const hasNavigation = sources.length > 1;
  const canSave = !!onSaveOriginal && (!items || items[currentIndex]?.source.kind === 'ready');
  if (!hasNavigation && !canSave) return null;
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.xs }}>
    <View style={{ flex: 1 }} />
    {hasNavigation ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.spacing.xs }}>
      <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
        accessibilityLabel="이전 이미지" testID={testIDFor('previous')} disabled={currentIndex === 0}
        onPress={() => onIndexChange(Math.max(0, currentIndex - 1))}>
        <Ionicons name="chevron-back" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
      </GlassButton>
      <Text testID={testIDFor('index')} style={{
        ...createSessionVisualRoles(t).chat.attachment.metadata,
        color: createSessionVisualRoles(t).chat.attachment.textMuted,
        minWidth: t.foundation.minHeight.secondary,
        textAlign: 'center',
      }}>{currentIndex + 1} / {sources.length}</Text>
      <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
        accessibilityLabel="다음 이미지" testID={testIDFor('next')} disabled={currentIndex === sources.length - 1}
        onPress={() => onIndexChange(Math.min(sources.length - 1, currentIndex + 1))}>
        <Ionicons name="chevron-forward" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
      </GlassButton>
    </View> : <View style={{ flex: 1 }} />}
    <View style={{ flex: 1, alignItems: 'flex-end' }}>
      {canSave ? <ImageSaveButton index={currentIndex} onSaveOriginal={onSaveOriginal!} /> : null}
    </View>
  </View>;
}

function ImageSaveButton({ index, onSaveOriginal }: {
  index: number;
  onSaveOriginal(index: number, anchor?: number): Promise<void>;
}) {
  const t = useTokens();
  const anchorRef = useRef<View | null>(null);
  const save = () => {
    const anchor = Platform.OS === 'ios' ? findNodeHandle(anchorRef.current) ?? undefined : undefined;
    void onSaveOriginal(index, anchor);
  };
  return <View ref={anchorRef} collapsable={false}>
    <GlassButton size="card" accessibilityLabel="원본 저장" testID="chat-image-viewer-save-original" onPress={save}>
      <Ionicons name="download-outline" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>원본 저장</Text>
    </GlassButton>
  </View>;
}

function testIDFor(name: 'previous' | 'index' | 'next'): string {
  return `chat-image-viewer-${name}`;
}

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(0, count - 1));
}
