import { useMemo } from "react";
import type { InternalLinkTarget } from "@seosoyoung/soul-ui";
import { CardImageViewer } from "./CardImageViewer";
import { DocumentReaderDialog } from "./DocumentReaderDialog";
import { useDashboardInternalLinks, useRegisterDashboardLinkOpeners } from "./DashboardInternalLinks";

export function InternalLinkViewers() {
  const { selectedDocumentId, selectedImage, openDocument, openImage, closeDocument, closeImage } = useDashboardInternalLinks();
  const openers = useMemo(() => ({
    document: (target: InternalLinkTarget) => target.kind === "document" ? openDocument(target.documentId) : false,
    attachment: (target: InternalLinkTarget, href: string) => target.kind === "attachment" && target.isImage ? openImage(href) : false,
  }), [openDocument, openImage]);
  useRegisterDashboardLinkOpeners(openers);
  return <>
    <DocumentReaderDialog documentId={selectedDocumentId} onClose={closeDocument}/>
    <CardImageViewer image={selectedImage} onClose={closeImage}/>
  </>;
}
