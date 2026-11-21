import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { ImageURISource } from 'react-native';
import type { AttachmentView } from '../lib/attachment-view';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { ContentLinkImageContext } from './ContentLinkContexts';

export function ContentLinkProvider({ children }: { children: React.ReactNode }) {
  const [source, setSource] = useState<ImageURISource | null>(null);
  const [attachment, setAttachment] = useState<{ item: AttachmentView; items?: readonly AttachmentView[]; initialIndex?: number } | null>(null);
  const close = useCallback(() => setSource(null), []);
  const restoreAttachmentFocus = useRef<(() => void) | undefined>(undefined);
  const closeAttachment = useCallback(() => {
    setAttachment(null);
    restoreAttachmentFocus.current?.();
    restoreAttachmentFocus.current = undefined;
  }, []);
  const openImage = useCallback((next: ImageURISource) => {
    setAttachment(null);
    setSource(next);
  }, []);
  const openAttachment = useCallback((next: AttachmentView, items?: readonly AttachmentView[], initialIndex?: number, restoreFocus?: () => void) => {
    setSource(null);
    restoreAttachmentFocus.current = restoreFocus;
    setAttachment({ item: next, items, initialIndex });
  }, []);
  const value = useMemo(() => ({ openImage, openAttachment, closeAttachment }), [closeAttachment, openAttachment, openImage]);

  return <ContentLinkImageContext.Provider value={value}>
    {children}
    {source ? <ImageViewerModal sources={[source]} initialIndex={0} onClose={close} /> : null}
    {attachment ? <AttachmentPreviewModal item={attachment.item} items={attachment.items} initialIndex={attachment.initialIndex} onClose={closeAttachment} /> : null}
  </ContentLinkImageContext.Provider>;
}
