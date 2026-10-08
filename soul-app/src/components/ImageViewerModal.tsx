import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { Image, Modal, ScrollView, StyleSheet, Text, View, useWindowDimensions, type ImageSourcePropType, type ImageURISource } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import { MODAL_BACKDROP_COLOR } from '../theme/surfaceRoles';
import { GlassButton, GlassSurface } from './GlassSurface';

export function ImageViewerModal(props: {
  captions?: readonly string[];
  sources: ImageSourcePropType[];
  initialIndex: number;
  onClose(): void;
  variant?: 'default' | 'chatRefined';
  filenames?: readonly string[];
  alts?: readonly string[];
  metadataLabels?: readonly string[];
}) {
  return props.variant === 'chatRefined'
    ? <ChatRefinedImageViewerModal {...props} />
    : <DefaultImageViewerModal {...props} />;
}

function DefaultImageViewerModal({ sources, initialIndex, onClose, captions }: {
  captions?: readonly string[];
  sources: ImageSourcePropType[]; initialIndex: number; onClose(): void;
}) {
  const t = useTokens();
  const window = useWindowDimensions();
  const [viewport, setViewport] = useState({ width: window.width, height: window.height });
  return <Modal visible transparent presentationStyle="overFullScreen" onRequestClose={onClose}>
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: MODAL_BACKDROP_COLOR }}>
        <View style={{ alignItems: 'flex-end', padding: t.spacing.md }}>
          <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round} accessibilityLabel="이미지 닫기" onPress={onClose}>
            <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>×</Text>
          </GlassButton>
        </View>
        <View style={{ flex: 1 }} onLayout={({ nativeEvent: { layout } }) => setViewport({ width: layout.width, height: layout.height })}>
          <ScrollView testID="image-viewer-pages" horizontal pagingEnabled showsHorizontalScrollIndicator={false}
            contentOffset={{ x: initialIndex * viewport.width, y: 0 }}>
            {sources.map((source, index) => captions?.[index] ? <CaptionedImagePage key={index} source={source} caption={captions[index]} index={index} viewport={viewport} /> : <ScrollView key={index} testID="image-viewer-zoom"
              style={{ width: viewport.width, height: viewport.height }}
              contentContainerStyle={{ width: viewport.width, height: viewport.height }}
              minimumZoomScale={1} maximumZoomScale={3} centerContent bouncesZoom
              showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
              <Image source={source} style={viewport} resizeMode="contain" accessibilityLabel={`이미지 ${index + 1}`} />
            </ScrollView>)}
          </ScrollView>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

function ChatRefinedImageViewerModal(props: {
  sources: ImageSourcePropType[];
  initialIndex: number;
  onClose(): void;
  variant?: 'default' | 'chatRefined';
  filenames?: readonly string[];
  alts?: readonly string[];
  metadataLabels?: readonly string[];
}) {
  const { sources, initialIndex, onClose } = props;
  return <Modal visible transparent presentationStyle="overFullScreen" onRequestClose={onClose}>
    <SafeAreaProvider>
      <ChatRefinedImageViewerContent {...props} />
    </SafeAreaProvider>
  </Modal>;
}

function ChatRefinedImageViewerContent({ sources, initialIndex, onClose, filenames = [], alts = [], metadataLabels = [] }: {
  sources: ImageSourcePropType[];
  initialIndex: number;
  onClose(): void;
  variant?: 'default' | 'chatRefined';
  filenames?: readonly string[];
  alts?: readonly string[];
  metadataLabels?: readonly string[];
}) {
  const t = useTokens();
  const device = useDeviceType();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const [currentIndex, setCurrentIndex] = useState(Math.min(Math.max(initialIndex, 0), sources.length - 1));
  const imageSource = sources[currentIndex] as ImageURISource;
  const filename = filenames[currentIndex] ?? '';
  const metadataLabel = metadataLabels[currentIndex] ?? '';
  const alt = alts[currentIndex] ?? filename;
  const hasNavigation = sources.length > 1;
  const moveTo = (nextIndex: number) => {
    if (nextIndex >= 0 && nextIndex < sources.length) setCurrentIndex(nextIndex);
  };

  return <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{
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
              {filename ? <Text numberOfLines={2} style={{
                ...attachment.metadata,
                color: attachment.textMuted,
              }}>{filename}</Text> : null}
              {metadataLabel ? <Text numberOfLines={1} style={{
                ...attachment.metadata,
                color: attachment.textMuted,
                marginTop: t.uiSpacing.xs,
              }}>{metadataLabel}</Text> : null}
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
            <Image
              testID="chat-image-viewer-image"
              source={imageSource}
              style={{ width: '100%', height: '100%', borderRadius: attachment.radius }}
              resizeMode="contain"
              accessibilityLabel={alt || filename || `이미지 ${currentIndex + 1}`}
            />
          </View>
          {hasNavigation ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.spacing.xs }}>
            <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
              accessibilityLabel="이전 이미지" testID="chat-image-viewer-previous"
              disabled={currentIndex === 0} onPress={() => moveTo(currentIndex - 1)}>
              <Ionicons name="chevron-back" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
            </GlassButton>
            <Text testID="chat-image-viewer-index" style={{
              ...attachment.metadata,
              color: attachment.textMuted,
              minWidth: t.foundation.minHeight.secondary,
              textAlign: 'center',
            }}>{currentIndex + 1} / {sources.length}</Text>
            <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round}
              accessibilityLabel="다음 이미지" testID="chat-image-viewer-next"
              disabled={currentIndex === sources.length - 1} onPress={() => moveTo(currentIndex + 1)}>
              <Ionicons name="chevron-forward" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
            </GlassButton>
          </View> : null}
        </View>
      </GlassSurface>
    </SafeAreaView>;
}

function CaptionedImagePage({ source, caption, index, viewport }: {
  source: ImageSourcePropType; caption: string; index: number; viewport: { width: number; height: number };
}) {
  const t = useTokens();
  const [imageArea, setImageArea] = useState(viewport);
  return <View style={viewport}>
    <View style={{ flex: 1 }} onLayout={({ nativeEvent: { layout } }) => setImageArea({ width: layout.width, height: layout.height })}>
      <ScrollView testID="image-viewer-zoom" style={{ flex: 1 }} contentContainerStyle={imageArea}
        minimumZoomScale={1} maximumZoomScale={3} centerContent bouncesZoom
        showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
        <Image source={source} style={imageArea} resizeMode="contain" accessibilityLabel={`이미지 ${index + 1}`} />
      </ScrollView>
    </View>
    <Text testID={`image-viewer-caption-${index}`} style={{ ...t.foundation.typography.body, color: t.colors.textPrimary,
      backgroundColor: t.colors.surface, textAlign: 'center', padding: t.spacing.md }}>{caption}</Text>
  </View>;
}
