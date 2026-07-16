export interface V3DocumentInspectorPort {
  setActiveBoardDocument(documentId: string): void;
  setInspectorOpen(open: boolean): void;
}

export function openDocumentInV3(documentId: string, port: V3DocumentInspectorPort): void {
  port.setActiveBoardDocument(documentId);
  port.setInspectorOpen(true);
}
