import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AccessibilityInfo,
  findNodeHandle,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
  type ImageURISource,
} from 'react-native';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import { getAttachmentImageSize } from '../lib/attachment-image-size';
import { ImageViewerModal } from './ImageViewerModal';

/** The thumbnail is the existing chat attachment Image, with a viewer on tap. */
export type ChatRefinedGalleryItem = {
  source: ImageURISource;
  filename: string;
  alt?: string;
  mimeType?: string;
  byteSize?: number;
};

type ChatImageMetadata = Pick<ChatRefinedGalleryItem, 'filename' | 'mimeType' | 'byteSize'>;

export function useChatImageMetadata(
  images: readonly ChatRefinedGalleryItem[],
  serverUrl: string,
): ChatRefinedGalleryItem[] {
  const requestIdentity = JSON.stringify(images.map(({ source }) => [
    source.uri ?? '',
    Object.entries(source.headers ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]));
  const [loadedMetadata, setLoadedMetadata] = useState<{
    requestIdentity: string;
    items: Array<Partial<ChatImageMetadata>>;
  }>({ requestIdentity: '', items: [] });

  useEffect(() => {
    if (images.length === 0) return;
    let active = true;
    void Promise.all(images.map(({ source }) => readProtectedAttachmentMetadata(source, serverUrl)))
      .then((items) => {
        if (active && items.some((item) => Object.keys(item).length > 0)) {
          setLoadedMetadata({ requestIdentity, items });
        }
      });
    return () => { active = false; };
  }, [requestIdentity, serverUrl]);

  const metadata = loadedMetadata.requestIdentity === requestIdentity ? loadedMetadata.items : [];
  return images.map((image, index) => ({
    ...image,
    filename: image.filename || metadata[index]?.filename || '',
    mimeType: image.mimeType ?? metadata[index]?.mimeType,
    byteSize: image.byteSize ?? metadata[index]?.byteSize,
  }));
}

export function AttachmentImage({ source, sources = [source], index = 0, testID, accessibilityLabel, captions, variant = 'default', filename, alt, mimeType, byteSize, chatImageRole = 'assistant', filenames, alts, mimeTypes, byteSizes }: {
  source: ImageSourcePropType; sources?: ImageSourcePropType[]; index?: number; testID?: string; accessibilityLabel: string;
  captions?: readonly string[];
  variant?: 'default' | 'cardCheckItem' | 'chatRefined';
  filename?: string;
  alt?: string;
  mimeType?: string;
  byteSize?: number;
  chatImageRole?: 'assistant' | 'user';
  filenames?: readonly string[];
  alts?: readonly string[];
  mimeTypes?: readonly (string | undefined)[];
  byteSizes?: readonly (number | undefined)[];
}) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  if (variant === 'chatRefined') {
    return <ChatRefinedAttachment source={source} sources={sources} index={index} testID={testID}
      accessibilityLabel={accessibilityLabel} filename={filename} alt={alt} role={chatImageRole}
      mimeType={mimeType} byteSize={byteSize} filenames={filenames} alts={alts}
      mimeTypes={mimeTypes} byteSizes={byteSizes} />;
  }
  const dimensions = variant === 'cardCheckItem' ? { width: 104, height: 60 } : { width: 200, height: 200 };
  return <>
    <TouchableWithoutFeedback onPress={() => setOpen(true)} accessibilityRole="button">
      <Image testID={testID} source={source} style={{ ...dimensions, borderRadius: t.radius.md, backgroundColor: t.colors.border }}
        resizeMode="cover" accessible accessibilityLabel={accessibilityLabel} />
    </TouchableWithoutFeedback>
    {open ? <ImageViewerModal sources={sources} captions={captions} initialIndex={index} onClose={() => setOpen(false)} /> : null}
  </>;
}

export function ChatRefinedImageGallery({ images, viewerImages = images, startIndex = 0, role, testID }: {
  images: ChatRefinedGalleryItem[];
  viewerImages?: ChatRefinedGalleryItem[];
  startIndex?: number;
  role: 'assistant' | 'user';
  testID: string;
}) {
  const t = useTokens();
  const device = useDeviceType();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const phone = device === 'phone';
  const sources = viewerImages.map((image) => image.source);
  const maxWidth = role === 'user'
    ? phone ? attachment.phoneUserMaxWidth : attachment.userMaxWidth
    : phone ? attachment.phoneAssistantMaxWidth : attachment.assistantMaxWidth;
  const cellStyle = images.length > 1
    ? { flexGrow: 1 as const, flexBasis: 0 as const, flexShrink: 1 as const, minWidth: 0 }
    : { width: '100%' as const };
  const renderImage = (image: ChatRefinedGalleryItem, index: number) => <View
    key={`${image.source.uri}-${index}`}
    style={cellStyle}
  >
    <AttachmentImage
      source={image.source}
      sources={sources}
      index={startIndex + index}
      variant="chatRefined"
      chatImageRole={role}
      filename={image.filename}
      alt={image.alt}
      mimeType={image.mimeType}
      byteSize={image.byteSize}
      filenames={viewerImages.map((entry) => entry.filename)}
      alts={viewerImages.map((entry) => entry.alt ?? '')}
      mimeTypes={viewerImages.map((entry) => entry.mimeType)}
      byteSizes={viewerImages.map((entry) => entry.byteSize)}
      accessibilityLabel={`${image.filename} 크게 보기`}
      testID={`${testID}-image-${index}`}
    />
  </View>;
  return <View
    testID={testID}
    accessibilityLabel={`이미지 ${images.length}개`}
    style={{
      width: '100%',
      maxWidth,
      alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
      flexDirection: 'column',
      gap: attachment.gridGap,
      marginTop: role === 'user' ? -t.uiSpacing.sm : t.spacing.lg,
      marginBottom: role === 'user' ? t.spacing.lg : t.uiSpacing.md,
    }}
  >
    {images.length > 1
      ? Array.from({ length: Math.ceil(images.length / 2) }, (_, rowIndex) => {
          const rowImages = images.slice(rowIndex * 2, rowIndex * 2 + 2);
          return <View
            key={`row-${rowIndex}`}
            testID={`${testID}-row-${rowIndex}`}
            style={{ width: '100%', flexDirection: 'row', gap: attachment.gridGap }}
          >
            {rowImages.map((image, columnIndex) => renderImage(image, rowIndex * 2 + columnIndex))}
            {rowImages.length === 1 ? <View pointerEvents="none" accessible={false} style={cellStyle} /> : null}
          </View>;
        })
      : images.map(renderImage)}
  </View>;
}

export function getChatAttachmentFilename(uri: string): string {
  try {
    const url = new URL(uri, 'https://attachment.invalid');
    const queryPath = url.searchParams.get('path');
    const candidate = queryPath ?? url.pathname;
    const basename = candidate.split(/[\\/]/).filter(Boolean).pop() ?? '';
    return queryPath ? basename : decodeURIComponent(basename);
  } catch {
    return '';
  }
}

export function isChatImageAttachmentPath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|heic|avif)$/i.test(path);
}

function ChatRefinedAttachment({ source, sources, index, testID, accessibilityLabel, filename, alt, mimeType, byteSize, role, filenames, alts, mimeTypes, byteSizes }: {
  source: ImageSourcePropType;
  sources: ImageSourcePropType[];
  index: number;
  testID?: string;
  accessibilityLabel: string;
  filename?: string;
  alt?: string;
  mimeType?: string;
  byteSize?: number;
  role: 'assistant' | 'user';
  filenames?: readonly string[];
  alts?: readonly string[];
  mimeTypes?: readonly (string | undefined)[];
  byteSizes?: readonly (number | undefined)[];
}) {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const triggerRef = useRef<any>(null);
  const [open, setOpen] = useState(false);
  const imageSource = source as ImageURISource;
  const uri = imageSource.uri ?? '';
  const headersKey = JSON.stringify(Object.entries(imageSource.headers ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  const [imageInfo, setImageInfo] = useState<{ uri: string; headersKey: string; aspectRatio: number | null; failed: boolean }>({
    uri,
    headersKey,
    aspectRatio: null,
    failed: false,
  });
  const currentInfo = imageInfo.uri === uri && imageInfo.headersKey === headersKey
    ? imageInfo
    : { uri, headersKey, aspectRatio: null, failed: false };
  useEffect(() => {
    let active = true;
    setImageInfo({ uri, headersKey, aspectRatio: null, failed: false });
    if (uri) {
      void getAttachmentImageSize(imageSource).then(({ width, height }) => {
        if (active && width > 0 && height > 0) {
          setImageInfo({ uri, headersKey, aspectRatio: width / height, failed: false });
        }
      }).catch(() => {
        if (active) setImageInfo({ uri, headersKey, aspectRatio: null, failed: true });
      });
    }
    return () => { active = false; };
  }, [headersKey, imageSource, uri]);

  const handleError = () => setImageInfo({ uri, headersKey, aspectRatio: null, failed: true });
  const metadataLabel = formatChatImageMetadata(mimeType, byteSize);
  const closeViewer = () => {
    setOpen(false);
    requestAnimationFrame(() => {
      if (Platform.OS === 'web') {
        triggerRef.current?.focus?.({ preventScroll: true });
        return;
      }
      const target = findNodeHandle(triggerRef.current);
      if (target != null) AccessibilityInfo.setAccessibilityFocus(target);
    });
  };

  return <>
    <Pressable
      ref={triggerRef}
      testID={testID}
      onPress={() => setOpen(true)}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={currentInfo.failed ? '이미지를 불러오지 못했습니다.' : undefined}
      accessibilityState={{ expanded: open }}
      style={{
        width: '100%',
        aspectRatio: currentInfo.aspectRatio ?? undefined,
        minHeight: t.hitTarget.min,
        borderRadius: attachment.radius,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: attachment.border,
        backgroundColor: attachment.surface,
        overflow: 'hidden',
      }}
    >
      {currentInfo.failed ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ ...attachment.metadata, color: attachment.textMuted, textAlign: 'center' }}>
          이미지를 불러오지 못했습니다.
        </Text>
      </View> : currentInfo.aspectRatio === null ? <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator testID="chat-image-loading" size="small" color={t.colors.accent} />
      </View> : <Image
        source={imageSource}
        onError={handleError}
        accessible={false}
        resizeMode="contain"
        style={{ width: '100%', height: '100%', borderRadius: attachment.radius }}
      />}
    </Pressable>
    {filename ? <Text numberOfLines={1} ellipsizeMode="tail" style={{
      ...attachment.metadata,
      color: attachment.textMuted,
      marginTop: attachment.filenameGap,
      textAlign: role === 'user' ? 'right' : 'left',
    }}>{filename}</Text> : null}
    {metadataLabel ? <Text numberOfLines={1} ellipsizeMode="tail" style={{
      ...attachment.metadata,
      color: attachment.textMuted,
      marginTop: t.uiSpacing.xs,
      textAlign: role === 'user' ? 'right' : 'left',
    }}>{metadataLabel}</Text> : null}
    {open ? <ImageViewerModal
      sources={sources}
      initialIndex={index}
      onClose={closeViewer}
      variant="chatRefined"
      filenames={filenames ?? sources.map((entry) => getChatAttachmentFilename((entry as ImageURISource).uri ?? ''))}
      alts={alts ?? sources.map(() => alt ?? '')}
      metadataLabels={sources.map((_, sourceIndex) => formatChatImageMetadata(mimeTypes?.[sourceIndex], byteSizes?.[sourceIndex]))}
    /> : null}
  </>;
}

export function formatChatImageMetadata(mimeType?: string, byteSize?: number): string {
  const parts = [mimeType, typeof byteSize === 'number' && Number.isFinite(byteSize) && byteSize > 0
    ? `${new Intl.NumberFormat().format(byteSize)} bytes`
    : undefined].filter((value): value is string => Boolean(value));
  return parts.join(' · ');
}

async function readProtectedAttachmentMetadata(source: ImageURISource, serverUrl: string): Promise<Partial<ChatImageMetadata>> {
  if (!source.uri || !serverUrl) return {};
  let url: URL;
  try {
    url = new URL(source.uri);
    if (url.origin !== new URL(serverUrl).origin || url.pathname !== '/api/attachments/files') return {};
  } catch {
    return {};
  }

  try {
    const response = await fetch(url.href, {
      method: 'HEAD',
      ...(Platform.OS === 'web'
        ? { credentials: 'same-origin' as const }
        : source.headers ? { headers: source.headers } : {}),
    });
    if (!response.ok) return {};

    const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim();
    const contentLength = response.headers.get('content-length');
    const byteSize = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined;
    const filename = filenameFromContentDisposition(response.headers.get('content-disposition'));
    return {
      ...(filename ? { filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(byteSize && Number.isFinite(byteSize) ? { byteSize } : {}),
    };
  } catch {
    return {};
  }
}

function filenameFromContentDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]?.trim();
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch { return undefined; }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return (plain?.[1] ?? plain?.[2])?.trim() || undefined;
}
