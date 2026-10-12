import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ImageURISource } from 'react-native';
import { ImageViewerModal } from '../components/ImageViewerModal';

interface ContentLinkImageHost {
  openImage(source: ImageURISource): void;
}

const ContentLinkImageContext = createContext<ContentLinkImageHost | null>(null);

export function ContentLinkProvider({ children }: { children: React.ReactNode }) {
  const [source, setSource] = useState<ImageURISource | null>(null);
  const close = useCallback(() => setSource(null), []);
  const value = useMemo(() => ({ openImage: setSource }), []);

  return <ContentLinkImageContext.Provider value={value}>
    {children}
    {source ? <ImageViewerModal sources={[source]} initialIndex={0} onClose={close} /> : null}
  </ContentLinkImageContext.Provider>;
}

export function useContentLinkImageHost(): ContentLinkImageHost | null {
  return useContext(ContentLinkImageContext);
}
