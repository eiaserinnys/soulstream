import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownDocumentPanel, useDashboardStore, type CatalogFolder, type InternalLinkTarget } from "@seosoyoung/soul-ui";
import {
  deleteMarkdownDocument,
  updateMarkdownDocument,
} from "@seosoyoung/soul-ui/lib/markdown-document-operations";
import { CardImageViewer } from "./CardImageViewer";
import { FolderDocumentOverlay } from "./FolderDocumentOverlay";
import {
  useDashboardInternalLinks,
  useRegisterDashboardLinkOpeners,
} from "./DashboardInternalLinks";

const EMPTY_FOLDERS: CatalogFolder[] = [];

export function InternalLinkViewers({ onDocumentDeleted }: { onDocumentDeleted?: () => void }) {
  const {
    selectedDocument,
    selectedImage,
    openDocument,
    openImage,
    closeDocument,
    closeImage,
    readSelectedDocument,
  } = useDashboardInternalLinks();
  const catalogFolders = useDashboardStore((state) => state.catalog?.folders);
  const folders = catalogFolders ?? EMPTY_FOLDERS;
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    setExpanded(true);
  }, [selectedDocument?.id]);
  const openers = useMemo(() => ({
    document: (target: InternalLinkTarget) => target.kind === "document"
      ? openDocument(target.documentId)
      : false,
    attachment: (target: InternalLinkTarget, href: string) => target.kind === "attachment" && target.isImage
      ? openImage(href)
      : false,
  }), [openDocument, openImage]);
  useRegisterDashboardLinkOpeners(openers);

  const closeTopViewer = useCallback((event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (selectedImage) {
      event.preventDefault();
      event.stopPropagation();
      closeImage();
    } else if (selectedDocument) {
      event.preventDefault();
      event.stopPropagation();
      closeDocument();
    }
  }, [closeDocument, closeImage, selectedDocument, selectedImage]);
  useEffect(() => {
    window.addEventListener("keydown", closeTopViewer, true);
    return () => window.removeEventListener("keydown", closeTopViewer, true);
  }, [closeTopViewer]);

  const documentFolder = selectedDocument?.folderId
    ? folders.find((folder) => folder.id === selectedDocument.folderId) ?? null
    : null;
  const parentFolder = documentFolder?.parentFolderId
    ? folders.find((folder) => folder.id === documentFolder.parentFolderId) ?? null
    : null;
  const actions = useMemo(() => ({
    read: readSelectedDocument,
    update: updateMarkdownDocument,
    remove: deleteMarkdownDocument,
  }), [readSelectedDocument]);
  const shell = typeof document === "undefined" ? null : document.querySelector(".v3-shell");

  return (
    <>
      {selectedDocument && shell ? createPortal(
        <div className="v3-workspace-scrim is-chat-open is-task-board">
          <div className="v3-workspace is-board-open v3-folder-board-workspace">
            <FolderDocumentOverlay
              expanded={expanded}
              projectTitle={parentFolder?.name ?? "미분류"}
              folderTitle={documentFolder?.name ?? ""}
              onToggleExpanded={() => setExpanded((value) => !value)}
              onClose={closeDocument}
            >
              <MarkdownDocumentPanel
                key={selectedDocument.id}
                documentId={selectedDocument.id}
                container={null}
                onPendingEditConsumed={() => {}}
                onClose={closeDocument}
                onDeleted={() => {
                  closeDocument();
                  onDocumentDeleted?.();
                }}
                actions={actions}
              />
            </FolderDocumentOverlay>
          </div>
        </div>,
        shell,
      ) : null}
      <CardImageViewer image={selectedImage} onClose={closeImage} />
    </>
  );
}
