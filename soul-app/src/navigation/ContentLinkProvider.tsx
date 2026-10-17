import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ImageURISource } from 'react-native';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import type { AttachmentLink } from '../lib/attachment-link-view';
import type { AttachmentView } from '../lib/attachment-view';
import { AttachmentPreviewModal } from '../components/AttachmentPreviewModal';
import { ImageViewerModal } from '../components/ImageViewerModal';

interface ContentLinkImageHost {
  openImage(source: ImageURISource): void;
  openAttachment(view: AttachmentView, items?: readonly AttachmentView[], initialIndex?: number, restoreFocus?: () => void): void;
}

const ContentLinkImageContext = createContext<ContentLinkImageHost | null>(null);
const AttachmentBlockContext = createContext<readonly AttachmentLink[] | undefined>(undefined);

const AttachmentReadContextContext = createContext<AttachmentReadContext | undefined>(undefined);

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
  const value = useMemo(() => ({ openImage, openAttachment }), [openAttachment, openImage]);

  return <ContentLinkImageContext.Provider value={value}>
    {children}
    {source ? <ImageViewerModal sources={[source]} initialIndex={0} onClose={close} /> : null}
    {attachment ? <AttachmentPreviewModal item={attachment.item} items={attachment.items} initialIndex={attachment.initialIndex} onClose={closeAttachment} /> : null}
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

export function AttachmentBlockProvider({ links, children }: { links: readonly AttachmentLink[]; children: React.ReactNode }) {
  return <AttachmentBlockContext.Provider value={links}>{children}</AttachmentBlockContext.Provider>;
}
export function useAttachmentBlockLinks() { return useContext(AttachmentBlockContext); }
