import React, { useState } from 'react';
import {
  Modal,
  Text,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { AttachmentView } from '../lib/attachment-view';
import { useTokens } from '../theme';
import { MODAL_BACKDROP_COLOR } from '../theme/surfaceRoles';
import { GlassButton } from './GlassSurface';
import { ImageViewerPages } from './ImageViewerPages';
import { AttachmentViewerFooter } from './AttachmentViewerFooter';
import { AttachmentViewerModal } from './AttachmentViewerModal';

export type ImageViewerModalProps = {
  captions?: readonly string[];
  sources: ImageSourcePropType[];
  initialIndex: number;
  onClose(): void;
  variant?: 'default' | 'chatRefined';
  filenames?: readonly string[];
  alts?: readonly string[];
  metadataLabels?: readonly string[];
  byteSizes?: readonly (number | undefined)[];
  renderAttachment?(item: AttachmentView, index: number): React.ReactNode;
  items?: readonly AttachmentView[];
  onSaveOriginal?(index: number, anchor?: number): Promise<void>;
};

export function ImageViewerModal(props: ImageViewerModalProps) {
  return props.variant === 'chatRefined'
    ? <AttachmentViewerModal {...props} />
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
        {sources.length > 1 || onSaveOriginal ? <View style={{ padding: t.spacing.md }}>
          <AttachmentViewerFooter count={sources.length} currentIndex={currentIndex} overlay
            onIndexChange={setCurrentIndex} onSaveOriginal={onSaveOriginal && (!items || items[currentIndex]?.source.kind === 'ready') ? onSaveOriginal : undefined} />
        </View> : null}
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

function clampIndex(index: number, count: number): number {
  return Math.min(Math.max(index, 0), Math.max(0, count - 1));
}
