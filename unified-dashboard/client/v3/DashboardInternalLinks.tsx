import {
  createContext,
  useLayoutEffect,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  InternalLinkProvider,
  useAuth,
  type InternalLinkTarget,
} from "@seosoyoung/soul-ui";
import type { MarkdownDocument } from "@seosoyoung/soul-ui";
import {
  deleteMarkdownDocument,
  fetchMarkdownDocument,
  updateMarkdownDocument,
} from "@seosoyoung/soul-ui/lib/markdown-document-operations";
import { internalLinkPath } from "@seosoyoung/soul-ui/lib/internal-link";
import { navigateDashboard } from "../dashboard-navigation";
import { useV3Notifications } from "./use-v3-notifications";
import { V3Toast } from "./V3Toast";
import type { CardImageSelection } from "./CardImageViewer";

type DashboardLinkOpener = (
  target: InternalLinkTarget,
  href: string,
) => void | boolean | Promise<void | boolean>;

export type DashboardLinkOpeners = Partial<Record<InternalLinkTarget["kind"], DashboardLinkOpener>>;

interface DashboardInternalLinksValue {
  registerOpeners(openers: DashboardLinkOpeners): () => void;
  openTarget(target: InternalLinkTarget, href: string): Promise<boolean>;
  selectedDocument: MarkdownDocument | null;
  selectedImage: CardImageSelection | null;
  openDocument(documentId: string): Promise<boolean>;
  openImage(href: string): Promise<boolean>;
  closeDocument(): void;
  closeImage(): void;
  readSelectedDocument(documentId: string): Promise<MarkdownDocument>;
}

const DashboardInternalLinksContext = createContext<DashboardInternalLinksValue | null>(null);

export function DashboardInternalLinks({ children }: { children: ReactNode }) {
  const { refreshAuthStatus } = useAuth();
  const { toast, notify } = useV3Notifications(refreshAuthStatus);
  const registrations = useRef(new Map<symbol, DashboardLinkOpeners>());
  const selectedDocumentRef = useRef<MarkdownDocument | null>(null);
  const firstDocumentReadId = useRef<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<MarkdownDocument | null>(null);
  const [selectedImage, setSelectedImage] = useState<CardImageSelection | null>(null);

  const registerOpeners = useCallback((openers: DashboardLinkOpeners) => {
    const token = Symbol("dashboard-link-openers");
    registrations.current.set(token, openers);
    return () => {
      registrations.current.delete(token);
    };
  }, []);

  const openDocument = useCallback(async (documentId: string): Promise<boolean> => {
    if (selectedDocumentRef.current?.id === documentId) return true;
    try {
      const document = await fetchMarkdownDocument(documentId);
      selectedDocumentRef.current = document;
      firstDocumentReadId.current = document.id;
      setSelectedDocument(document);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "마크다운 문서를 불러오지 못했습니다.");
      return false;
    }
  }, [notify]);

  const openImage = useCallback((href: string): Promise<boolean> => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      setSelectedImage({ src: href, alt: "" });
      resolve(true);
    };
    image.onerror = () => {
      notify("이미지를 불러오지 못했습니다.");
      resolve(false);
    };
    image.src = href;
  }), [notify]);

  const closeDocument = useCallback(() => {
    selectedDocumentRef.current = null;
    firstDocumentReadId.current = null;
    setSelectedDocument(null);
  }, []);
  const closeImage = useCallback(() => setSelectedImage(null), []);

  const readSelectedDocument = useCallback((documentId: string): Promise<MarkdownDocument> => {
    if (firstDocumentReadId.current === documentId && selectedDocumentRef.current) {
      firstDocumentReadId.current = null;
      return Promise.resolve(selectedDocumentRef.current);
    }
    return fetchMarkdownDocument(documentId);
  }, []);

  const openTarget = useCallback(async (target: InternalLinkTarget, href: string): Promise<boolean> => {
    const registered = [...registrations.current.values()].reverse();
    const opener = registered
      .map((candidate) => candidate[target.kind])
      .find((candidate) => candidate !== undefined);
    if (opener) return (await opener(target, href)) !== false;

    const path = internalLinkPath(target);
    if (path) {
      navigateDashboard(path);
      return true;
    }
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  }, []);

  const value = useMemo<DashboardInternalLinksValue>(() => ({
    registerOpeners,
    openTarget,
    selectedDocument,
    selectedImage,
    openDocument,
    openImage,
    closeDocument,
    closeImage,
    readSelectedDocument,
  }), [closeDocument, closeImage, openDocument, openImage, openTarget, readSelectedDocument, registerOpeners, selectedDocument, selectedImage]);

  return (
    <DashboardInternalLinksContext.Provider value={value}>
      <InternalLinkProvider internalOrigins={[window.location.origin]} openTarget={openTarget}>
        {children}
        <V3Toast message={toast} />
      </InternalLinkProvider>
    </DashboardInternalLinksContext.Provider>
  );
}

export function useDashboardInternalLinks(): DashboardInternalLinksValue {
  const context = useContext(DashboardInternalLinksContext);
  if (!context) throw new Error("DashboardInternalLinks provider is required");
  return context;
}

export function useRegisterDashboardLinkOpeners(openers: DashboardLinkOpeners): void {
  const { registerOpeners } = useDashboardInternalLinks();
  useLayoutEffect(() => registerOpeners(openers), [openers, registerOpeners]);
}
