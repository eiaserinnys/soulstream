import React, { useMemo, useState } from 'react';
import { View } from 'react-native';
import { captureAuthScope } from '../lib/auth-scope';
import type { AttachmentView } from '../lib/attachment-view';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../theme';
import { AttachmentFileRow } from './AttachmentFileRow';
import { ChatRefinedImageGallery, type ChatRefinedGalleryItem } from './AttachmentImage';
import { AttachmentPreviewModal, saveAttachmentOriginalView } from './AttachmentPreviewModal';

export function MessageAttachments({ items, role, presentation = 'default' }: {
  items: readonly AttachmentView[];
  role: 'assistant' | 'user';
  presentation?: 'default' | 'manuscript';
}) {
  const t = useTokens();
  const device = useDeviceType();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const [selectedFile, setSelectedFile] = useState<AttachmentView | null>(null);
  const authScope = captureAuthScope();
  const images = useMemo(() => items.filter((item): item is AttachmentView & {
    previewKind: 'image'; source: Extract<AttachmentView['source'], { kind: 'ready' }>;
  } => item.previewKind === 'image' && item.source.kind === 'ready'), [items]);
  const fileRows = useMemo(() => items.filter((item) => item.previewKind !== 'image' || item.source.kind !== 'ready'), [items]);
  const galleryImages: ChatRefinedGalleryItem[] = images.map((item) => ({
    source: toImageSource(item, authScope.serverUrl, authScope.jwt),
    filename: item.name,
    alt: item.name,
    mimeType: item.mimeType ?? undefined,
    byteSize: item.byteSize ?? undefined,
  }));
  const maxWidth = role === 'user'
    ? device === 'phone' ? attachment.phoneUserMaxWidth : attachment.userMaxWidth
    : device === 'phone' ? attachment.phoneAssistantMaxWidth : attachment.assistantMaxWidth;
  const imageViews = images;

  if (items.length === 0) return null;
  return <>
    {images.length > 0 ? <ChatRefinedImageGallery
      images={galleryImages}
      role={role}
      testID="message-attachments-images"
      items={imageViews}
      followedByAttachments={fileRows.length > 0}
      onSaveOriginal={async (index, anchor) => { await saveAttachmentOriginalView(imageViews[index], anchor); }}
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
        onPress={() => setSelectedFile(item)}
      />)}
    </View> : null}
    {selectedFile ? <AttachmentPreviewModal item={selectedFile} onClose={() => setSelectedFile(null)} /> : null}
  </>;
}

function toImageSource(item: AttachmentView & { source: Extract<AttachmentView['source'], { kind: 'ready' }> }, serverUrl: string, jwt: string | null) {
  const value = item.source.previewUrl ?? item.source.originalUrl;
  try {
    const url = new URL(value, `${serverUrl.replace(/\/+$/, '')}/`);
    const sameOrigin = url.origin === new URL(serverUrl).origin;
    const headers = sameOrigin && jwt ? { Authorization: `Bearer ${jwt}` } : undefined;
    return { uri: url.toString(), ...(headers ? { headers } : {}) };
  } catch {
    return { uri: '' };
  }
}
