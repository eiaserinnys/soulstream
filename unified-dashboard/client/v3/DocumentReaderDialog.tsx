import { useEffect, useState } from "react";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogPanel, MarkdownContent, type MarkdownDocument } from "@seosoyoung/soul-ui";
import { removeOverlappingDocumentHeading } from "@seosoyoung/soul-ui/lib/markdown-document-heading";
import "./v3-folder-board.css";

export function DocumentReaderDialog({ documentId, onClose, request = globalThis.fetch }: {
  documentId: string | null;
  onClose(): void;
  request?: typeof globalThis.fetch;
}) {
  const [document, setDocument] = useState<MarkdownDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDocument(null);
    setError(null);
    if (!documentId) return;
    const controller = new AbortController();
    void request(`/api/markdown-documents/${encodeURIComponent(documentId)}`, {
      credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        if (!controller.signal.aborted) setError(response.status === 404 ? "문서를 찾을 수 없습니다" : "문서를 불러오지 못했습니다");
        return;
      }
      const next = await response.json() as MarkdownDocument;
      if (!controller.signal.aborted) setDocument(next);
    }).catch(() => {
      if (!controller.signal.aborted) setError("문서를 불러오지 못했습니다");
    });
    return () => controller.abort();
  }, [documentId, request]);
  return <Dialog open={documentId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogPopup className="v3-surface max-w-3xl" data-testid="internal-document-dialog">
      {document ? <DialogHeader><DialogTitle>{document.title}</DialogTitle></DialogHeader> : <DialogTitle className="sr-only">문서</DialogTitle>}
      <DialogPanel>
        {error ? <p className="v3-inline-board-error">{error}</p> : null}
        {!document && !error ? <p className="v3-detail-empty">본문을 불러오는 중…</p> : null}
        {document ? <div className="v3-folder-board-document-copy"><MarkdownContent content={removeOverlappingDocumentHeading(document.body, document.title)} codeBlockLayout="document"/></div> : null}
      </DialogPanel>
    </DialogPopup>
  </Dialog>;
}
