import type { SessionSummary } from "@seosoyoung/soul-ui";

import { activateRunSession, type RunSessionActivationPort } from "./task-workspace-model";

export interface V3SessionInspectorPort extends RunSessionActivationPort {
  setInspectorOpen(open: boolean): void;
}

export interface V3DocumentInspectorPort {
  setActiveBoardDocument(documentId: string): void;
  setInspectorOpen(open: boolean): void;
}

export function openSessionInV3(session: SessionSummary, port: V3SessionInspectorPort): void {
  activateRunSession(session, port);
  port.setInspectorOpen(true);
}

export function openDocumentInV3(documentId: string, port: V3DocumentInspectorPort): void {
  port.setActiveBoardDocument(documentId);
  port.setInspectorOpen(true);
}
