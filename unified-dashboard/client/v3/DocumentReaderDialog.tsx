import { useEffect, useRef, useState } from "react";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, FrameLoading, FrameNotice, MarkdownContent, type MarkdownDocument } from "@seosoyoung/soul-ui";
import { removeOverlappingDocumentHeading } from "@seosoyoung/soul-ui/lib/markdown-document-heading";
import "./v3-document-reader-dialog.css";

export function DocumentReaderDialog({ documentId, onClose, request = globalThis.fetch }: {
  documentId: string | null;
  onClose(): void;
  request?: typeof globalThis.fetch;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [lastDocumentId, setLastDocumentId] = useState(documentId);
  const [content, setContent] = useState<{ documentId: string; document: MarkdownDocument | null; error: string | null } | null>(null);
  if (documentId !== null && documentId !== lastDocumentId) setLastDocumentId(documentId);
  const visibleDocumentId = documentId ?? lastDocumentId;
  const document = content?.documentId === visibleDocumentId ? content.document : null;
  const error = content?.documentId === visibleDocumentId ? content.error : null;
  useEffect(() => {
    if (!documentId) return;
    setContent((previous) => previous?.documentId === documentId && previous.document ? previous : { documentId, document: null, error: null });
    const controller = new AbortController();
    void request(`/api/markdown-documents/${encodeURIComponent(documentId)}`, {
      credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        if (!controller.signal.aborted) setContent({ documentId, document: null, error: response.status === 404 ? "문서를 찾을 수 없습니다" : "문서를 불러오지 못했습니다" });
        return;
      }
      const next = await response.json() as MarkdownDocument;
      if (!controller.signal.aborted) setContent({ documentId, document: next, error: null });
    }).catch(() => {
      if (!controller.signal.aborted) setContent({ documentId, document: null, error: "문서를 불러오지 못했습니다" });
    });
    return () => controller.abort();
  }, [documentId, request]);
  return <Dialog open={documentId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPopup initialFocus={panelRef} className="v3-surface v3-document-reader-dialog max-w-3xl" closeProps={{ "aria-label": "문서 닫기" }} data-testid="internal-document-dialog">
      <DialogHeader className="pe-14"><DialogTitle data-v3-selectable-content={document ? "true" : undefined} className="min-h-7 leading-7">{document ? document.title : <span className="sr-only">문서</span>}</DialogTitle></DialogHeader>
      <DialogPanel ref={panelRef} tabIndex={0} role="region" aria-label="문서 본문">
        {error ? <FrameNotice><p data-v3-selectable-content="true">{error}</p></FrameNotice> : null}
        {!document && !error ? <FrameLoading label="본문을 불러오는 중…" /> : null}
        {document ? <div className="v3-folder-board-document-copy" data-v3-selectable-content="true"><MarkdownContent content={removeOverlappingDocumentHeading(document.body, document.title)} codeBlockLayout="document"/></div> : null}
      </DialogPanel>
    </DialogPopup>
  </Dialog>;
}
