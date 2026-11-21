import React, { createContext, useContext } from 'react';
import type { ImageURISource } from 'react-native';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import type { AttachmentLink } from '../lib/attachment-link-view';
import type { AttachmentView } from '../lib/attachment-view';

interface ContentLinkImageHost {
  openImage(source: ImageURISource): void;
  closeAttachment(): void;
  openAttachment(view: AttachmentView, items?: readonly AttachmentView[], initialIndex?: number, restoreFocus?: () => void): void;
}

export const ContentLinkImageContext = createContext<ContentLinkImageHost | null>(null);
const AttachmentBlockContext = createContext<readonly AttachmentLink[] | undefined>(undefined);

const AttachmentReadContextContext = createContext<AttachmentReadContext | undefined>(undefined);

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
