import { useMemo } from "react";
import type { InternalLinkTarget } from "@seosoyoung/soul-ui";
import { CardImageViewer } from "./CardImageViewer";
import { DocumentReaderDialog } from "./DocumentReaderDialog";
import { useDashboardInternalLinks, useRegisterDashboardLinkOpeners } from "./DashboardInternalLinks";

export function InternalLinkViewers() {
  const { selectedDocumentId, selectedImage, selectedAttachment, attachmentReturnFocus, openDocument, openImage, openAttachment, closeDocument, closeImage, closeAttachment } = useDashboardInternalLinks();
  const openers = useMemo(() => ({
    document: (target: InternalLinkTarget) => target.kind === "document" ? openDocument(target.documentId) : false,
    attachment: (target: InternalLinkTarget, href: string) => target.kind === "attachment" && target.isImage ? openImage(href) : false,
    attachment_asset: (target: InternalLinkTarget) => target.kind === "attachment_asset" ? openAttachment(target) : false,
  }), [openAttachment, openDocument, openImage]);
  useRegisterDashboardLinkOpeners(openers);
  const attachment = selectedAttachment?.image.attachment;
  return <>
    <DocumentReaderDialog documentId={selectedDocumentId} onClose={closeDocument}/>
    <CardImageViewer image={selectedImage} onClose={closeImage}/>
    <CardImageViewer
      image={selectedAttachment?.image ?? null}
      attachments={attachment ? [attachment] : []}
      attachmentStatus={attachment && selectedAttachment?.status ? { [attachment.key]: selectedAttachment.status } : undefined}
      returnFocus={attachmentReturnFocus}
      onClose={closeAttachment}
    />
  </>;
}
