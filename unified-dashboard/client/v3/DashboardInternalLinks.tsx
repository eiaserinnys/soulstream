import {
  createContext,
  useEffect,
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
import { internalLinkPath } from "@seosoyoung/soul-ui/lib/internal-link";
import { attachmentContentUrl } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import { navigateDashboard } from "../dashboard-navigation";
import { useV3Notifications } from "./use-v3-notifications";
import { V3Toast } from "./V3Toast";
import type { CardAttachmentStatus, CardImageSelection } from "./CardImageViewer";
import { type AttachmentReadContext } from "./card-attachment-selection";
import { loadAttachmentAsset, unavailableItem } from "./attachment-asset-loader";

type DashboardLinkOpener = (
  target: InternalLinkTarget,
  href: string,
  label?: string,
) => void | boolean | Promise<void | boolean>;

export type DashboardLinkOpeners = Partial<Record<InternalLinkTarget["kind"], DashboardLinkOpener>>;

interface DashboardInternalLinksValue {
  registerOpeners(openers: DashboardLinkOpeners): () => void;
  openTarget(target: InternalLinkTarget, href: string, label?: string): Promise<boolean>;
  selectedDocumentId: string | null;
  selectedImage: CardImageSelection | null;
  selectedAttachment: { image: CardImageSelection; status?: CardAttachmentStatus } | null;
  attachmentReturnFocus: HTMLElement | null;
  openDocument(documentId: string): boolean;
  openImage(href: string): Promise<boolean>;
  openAttachment(target: Extract<InternalLinkTarget, { kind: "attachment_asset" }>, label?: string): Promise<boolean>;
  closeDocument(): void;
  closeImage(): void;
  closeAttachment(): void;
}

const DashboardInternalLinksContext = createContext<DashboardInternalLinksValue | null>(null);

export function DashboardInternalLinks({ children }: { children: ReactNode }) {
  const { refreshAuthStatus } = useAuth();
  const { toast, notify } = useV3Notifications(refreshAuthStatus);
  const registrations = useRef(new Map<symbol, DashboardLinkOpeners>());
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [selectedImage, setSelectedImage] = useState<CardImageSelection | null>(null);
  const [selectedAttachment, setSelectedAttachment] = useState<{ image: CardImageSelection; status?: CardAttachmentStatus } | null>(null);
  const attachmentRequest = useRef<AbortController | null>(null);
  const attachmentReturnFocus = useRef<HTMLElement | null>(null);

  const registerOpeners = useCallback((openers: DashboardLinkOpeners) => {
    const token = Symbol("dashboard-link-openers");
    registrations.current.set(token, openers);
    return () => {
      registrations.current.delete(token);
    };
  }, []);

  const openDocument = useCallback((documentId: string): boolean => {
    setSelectedDocumentId(documentId);
    return true;
  }, []);

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
    setSelectedDocumentId(null);
  }, []);
  const closeImage = useCallback(() => setSelectedImage(null), []);

  const openAttachment = useCallback(async (
    target: Extract<InternalLinkTarget, { kind: "attachment_asset" }>,
    label?: string,
  ): Promise<boolean> => {
    attachmentRequest.current?.abort();
    const controller = new AbortController();
    attachmentRequest.current = controller;
    attachmentReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const context = (target.context ?? { type: "owner" }) as AttachmentReadContext;
    const reference = {
      attachmentId: target.attachmentId,
      context,
      key: `asset:${target.attachmentId}`,
      label: label ?? "",
    };
    const placeholder = unavailableItem(reference, "unavailable");
    const src = attachmentContentUrl(target.attachmentId, context);
    setSelectedAttachment({
      image: { src, alt: reference.label, attachment: placeholder },
      status: { message: "미리보기를 불러오는 중…" },
    });

    const load = async (request: AbortController): Promise<void> => {
      try {
        const result = await loadAttachmentAsset(reference, request.signal);
        if (request.signal.aborted || attachmentRequest.current !== request) return;
        const status = result.status
          ? {
            message: result.status.message,
            ...(result.status.retryable ? {
              onRetry: () => {
                attachmentRequest.current?.abort();
                const retry = new AbortController();
                attachmentRequest.current = retry;
                setSelectedAttachment(current => current
                  ? { ...current, status: { message: "미리보기를 불러오는 중…" } }
                  : current);
                void load(retry);
              },
            } : {}),
          }
          : undefined;
        setSelectedAttachment({
          image: {
            src: result.item.previewUrl ?? result.item.originalUrl ?? src,
            alt: reference.label,
            attachment: result.item,
          },
          ...(status ? { status } : {}),
        });
      } catch (error) {
        if (!request.signal.aborted) throw error;
      }
    };

    void load(controller);
    return true;
  }, []);

  const closeAttachment = useCallback(() => {
    attachmentRequest.current?.abort();
    attachmentRequest.current = null;
    setSelectedAttachment(null);
    requestAnimationFrame(() => attachmentReturnFocus.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => () => attachmentRequest.current?.abort(), []);

  const openTarget = useCallback(async (target: InternalLinkTarget, href: string, label?: string): Promise<boolean> => {
    if (target.kind !== "document" && target.kind !== "attachment_asset" && !(target.kind === "attachment" && target.isImage)) closeDocument();
    const registered = [...registrations.current.values()].reverse();
    const opener = registered
      .map((candidate) => candidate[target.kind])
      .find((candidate) => candidate !== undefined);
    if (opener) return (await opener(target, href, label)) !== false;

    const path = internalLinkPath(target);
    if (path) {
      navigateDashboard(path);
      return true;
    }
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  }, [closeDocument]);

  const value = useMemo<DashboardInternalLinksValue>(() => ({
    registerOpeners,
    openTarget,
    selectedDocumentId,
    selectedImage,
    selectedAttachment,
    attachmentReturnFocus: attachmentReturnFocus.current,
    openDocument,
    openImage,
    openAttachment,
    closeDocument,
    closeImage,
    closeAttachment,
  }), [closeAttachment, closeDocument, closeImage, openAttachment, openDocument, openImage, openTarget, registerOpeners, selectedAttachment, selectedDocumentId, selectedImage]);

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
