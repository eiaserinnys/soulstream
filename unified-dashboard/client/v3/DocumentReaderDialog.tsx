import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, FrameLoading, FrameNotice, MarkdownContent, type MarkdownDocument } from "@seosoyoung/soul-ui";
import { removeOverlappingDocumentHeading } from "@seosoyoung/soul-ui/lib/markdown-document-heading";
import { registerDashboardReader } from "../pwa/dashboard-reload";
import "./v3-document-reader-dialog.css";

export function DocumentReaderDialog({ documentId, onClose, request = globalThis.fetch }: {
  documentId: string | null;
  onClose(): void;
  request?: typeof globalThis.fetch;
}) {
 const {t}=useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [lastDocumentId, setLastDocumentId] = useState(documentId);
  const [content, setContent] = useState<{ documentId: string; document: MarkdownDocument | null; error: string | null } | null>(null);
  if (documentId !== null && documentId !== lastDocumentId) setLastDocumentId(documentId);
  const visibleDocumentId = documentId ?? lastDocumentId;
  const document = content?.documentId === visibleDocumentId ? content.document : null;
  const error = content?.documentId === visibleDocumentId ? content.error : null;
  const isOpen = documentId !== null;
  useEffect(() => isOpen ? registerDashboardReader() : undefined, [isOpen]);
  useEffect(() => {
    if (!documentId) return;
    setContent((previous) => previous?.documentId === documentId && previous.document ? previous : { documentId, document: null, error: null });
    const controller = new AbortController();
    void request(`/api/markdown-documents/${encodeURIComponent(documentId)}`, {
      credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        if (!controller.signal.aborted) setContent({ documentId, document: null, error: response.status === 404 ? t("cards.documentMissing") : t("cards.documentLoadError") });
        return;
      }
      const next = await response.json() as MarkdownDocument;
      if (!controller.signal.aborted) setContent({ documentId, document: next, error: null });
    }).catch(() => {
      if (!controller.signal.aborted) setContent({ documentId, document: null, error: t("cards.documentLoadError") });
    });
    return () => controller.abort();
  }, [documentId, request, t]);
  return <Dialog open={documentId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPopup initialFocus={panelRef} className="v3-surface v3-document-reader-dialog max-w-3xl" closeProps={{ "aria-label": t("cards.closeDocument") }} data-testid="internal-document-dialog">
      <DialogHeader className="pe-14"><DialogTitle data-v3-selectable-content={document ? "true" : undefined} className="min-h-7 leading-7">{document ? document.title : <span className="sr-only">{t("cards.document")}</span>}</DialogTitle></DialogHeader>
      <DialogPanel ref={panelRef} tabIndex={0} role="region" aria-label={t("cards.documentBody")}>
        {error ? <FrameNotice><p data-v3-selectable-content="true">{error}</p></FrameNotice> : null}
        {!document && !error ? <FrameLoading label={t("cards.documentLoading")} /> : null}
        {document ? <div className="v3-folder-board-document-copy" data-v3-selectable-content="true"><MarkdownContent content={removeOverlappingDocumentHeading(document.body, document.title)} codeBlockLayout="document"/></div> : null}
      </DialogPanel>
    </DialogPopup>
  </Dialog>;
}
