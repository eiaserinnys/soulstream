import React, { useState } from 'react';
import { Image, Modal, ScrollView, Text, View, useWindowDimensions, type ImageSourcePropType } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useTokens } from '../theme';
import { MODAL_BACKDROP_COLOR } from '../theme/surfaceRoles';
import { GlassButton } from './GlassSurface';

export function ImageViewerModal({ sources, initialIndex, onClose }: {
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
            {sources.map((source, index) => <ScrollView key={index} testID="image-viewer-zoom"
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
