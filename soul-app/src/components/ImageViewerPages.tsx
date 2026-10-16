import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
  type ImageURISource,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { AttachmentView } from '../lib/attachment-view';
import { createSessionVisualRoles, useTokens } from '../theme';

export function ImageViewerPages({
  sources,
  currentIndex,
  onIndexChange,
  captions,
  items,
  style,
  activeImageTestID,
  renderAttachment,
}: {
  sources: readonly ImageSourcePropType[];
  currentIndex: number;
  onIndexChange(index: number): void;
  captions?: readonly string[];
  items?: readonly AttachmentView[];
  style?: StyleProp<ViewStyle>;
  activeImageTestID?: string;
  renderAttachment?(item: AttachmentView, index: number): React.ReactNode;
}) {
  const t = useTokens();
  const roles = createSessionVisualRoles(t).chat.attachment;
  const window = useWindowDimensions();
  const [viewport, setViewport] = useState({ width: window.width, height: window.height });
  const scrollRef = useRef<ScrollView | null>(null);
  const [failedPages, setFailedPages] = useState<Record<string, true>>({});
  const pageCount = sources.length;
  const boundedIndex = Math.min(Math.max(currentIndex, 0), Math.max(pageCount - 1, 0));

  useEffect(() => {
    if (viewport.width > 0) {
      scrollRef.current?.scrollTo({ x: boundedIndex * viewport.width, y: 0, animated: false });
    }
  }, [boundedIndex, viewport.width]);

  const updateViewport = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (layout.width > 0 && layout.height > 0) setViewport({ width: layout.width, height: layout.height });
  };
  const handlePagingEnd = (event: { nativeEvent: { contentOffset: { x: number }; layoutMeasurement?: { width: number } } }) => {
    const width = event.nativeEvent.layoutMeasurement?.width || viewport.width;
    if (width <= 0) return;
    const nextIndex = Math.min(Math.max(Math.round(event.nativeEvent.contentOffset.x / width), 0), pageCount - 1);
    if (nextIndex !== boundedIndex) onIndexChange(nextIndex);
  };

  return <View style={[{ flex: 1 }, style]} onLayout={updateViewport}>
    <ScrollView
      ref={scrollRef}
      testID="image-viewer-pages"
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      contentOffset={{ x: boundedIndex * viewport.width, y: 0 }}
      onMomentumScrollEnd={handlePagingEnd}
    >
      {sources.map((source, index) => {
        const item = items?.[index];
        if (item && renderAttachment && (item.previewKind !== 'image' || item.source.kind !== 'ready')) {
          return <View key={item.key} style={viewport}>{index === boundedIndex ? renderAttachment(item, index) : null}</View>;
        }
        const sourceKey = `${index}:${typeof source === 'number' ? source : JSON.stringify(source)}`;
        const failureMessage = item?.source.kind === 'unavailable'
          ? item.source.availability === 'missing' ? '찾을 수 없음' : '불러오지 못함'
          : '불러오지 못함';
        const failed = item?.source.kind === 'unavailable' || !!failedPages[sourceKey];
        return <ViewerImagePage
          key={sourceKey}
          source={source}
          index={index}
          name={item?.name}
          caption={captions?.[index]}
          viewport={viewport}
          failed={failed}
          failureMessage={failureMessage}
          onError={() => setFailedPages((previous) => ({ ...previous, [sourceKey]: true }))}
          roleStyles={roles}
          tokens={t}
          imageTestID={index === boundedIndex ? activeImageTestID : undefined}
        />;
      })}
    </ScrollView>
  </View>;
}

function ViewerImagePage({ source, index, name, caption, viewport, failed, failureMessage, onError, roleStyles, tokens, imageTestID }: {
  source: ImageSourcePropType;
  index: number;
  name?: string;
  caption?: string;
  viewport: { width: number; height: number };
  failed: boolean;
  failureMessage: string;
  onError(): void;
  roleStyles: ReturnType<typeof createSessionVisualRoles>['chat']['attachment'];
  tokens: ReturnType<typeof useTokens>;
  imageTestID?: string;
}) {
  const [imageArea, setImageArea] = useState(viewport);
  const imageSource = source as ImageURISource;
  const updateImageArea = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (layout.width > 0 && layout.height > 0) setImageArea({ width: layout.width, height: layout.height });
  };
  return <View testID={`image-viewer-page-${index}`} style={viewport}>
    <View style={{ flex: 1 }} onLayout={updateImageArea}>
      <ScrollView testID="image-viewer-zoom" style={{ flex: 1 }} contentContainerStyle={imageArea}
        minimumZoomScale={1} maximumZoomScale={3} centerContent bouncesZoom
        showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
        <Image testID={imageTestID ?? `image-viewer-image-${index}`} source={source} style={imageArea} resizeMode="contain"
          accessible accessibilityLabel={name || `이미지 ${index + 1}`} onError={onError} />
        {failed ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <Text style={{ ...tokens.foundation.typography.body, color: tokens.colors.textPrimary, textAlign: 'center' }}>{failureMessage}</Text>
        </View> : null}
      </ScrollView>
    </View>
    {caption ? <Text testID={`image-viewer-caption-${index}`} numberOfLines={1} ellipsizeMode="tail" style={{
      ...tokens.foundation.typography.body,
      color: tokens.colors.textPrimary,
      backgroundColor: tokens.colors.surface,
      textAlign: 'center',
      padding: tokens.spacing.md,
    }}>{caption}</Text> : null}
  </View>;
}
