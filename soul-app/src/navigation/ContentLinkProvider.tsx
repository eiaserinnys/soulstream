import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ImageURISource } from 'react-native';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import type { AttachmentView } from '../lib/attachment-view';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { ImageViewerModal } from '../components/ImageViewerModal';

interface ContentLinkImageHost {
  openImage(source: ImageURISource): void;
  openAttachment(view: AttachmentView): void;
}

const ContentLinkImageContext = createContext<ContentLinkImageHost | null>(null);
const AttachmentReadContextContext = createContext<AttachmentReadContext | undefined>(undefined);

export function ContentLinkProvider({ children }: { children: React.ReactNode }) {
  const [source, setSource] = useState<ImageURISource | null>(null);
  const [attachment, setAttachment] = useState<AttachmentView | null>(null);
  const close = useCallback(() => setSource(null), []);
  const closeAttachment = useCallback(() => setAttachment(null), []);
  const openImage = useCallback((next: ImageURISource) => {
    setAttachment(null);
    setSource(next);
  }, []);
  const openAttachment = useCallback((next: AttachmentView) => {
    setSource(null);
    setAttachment(next);
  }, []);
  const value = useMemo(() => ({ openImage, openAttachment }), [openAttachment, openImage]);

  return <ContentLinkImageContext.Provider value={value}>
    {children}
    {source ? <ImageViewerModal sources={[source]} initialIndex={0} onClose={close} /> : null}
    {attachment ? <AttachmentPreviewModal item={attachment} onClose={closeAttachment} /> : null}
  </ContentLinkImageContext.Provider>;
}

export function useContentLinkImageHost(): ContentLinkImageHost | null {
  return useContext(ContentLinkImageContext);
}

export function AttachmentReadContextProvider({ context, children }: {
  context: AttachmentReadContext;
  children: React.ReactNode;
}) {
  return <AttachmentReadContextContext.Provider value={context}>{children}</AttachmentReadContextContext.Provider>;
}

export function useAttachmentReadContext(): AttachmentReadContext | undefined {
  return useContext(AttachmentReadContextContext);
}
