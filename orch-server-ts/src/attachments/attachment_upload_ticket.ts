import { signJwt, verifySignedJwt } from "../runtime/live_auth_route_provider.js";

export const LARGE_ATTACHMENT_MAX_SIZE = 5 * 1024 ** 3;
export const LARGE_ATTACHMENT_PART_SIZE = 16 * 1024 ** 2;
export const ATTACHMENT_TICKET_SECONDS = 3600;
export interface AttachmentUploadTicket {
  purpose: "session_attachment_upload";
  sub: string;
  sessionId: string;
  folderId: string | null;
  nodeId: string;
  storageKey: string;
  uploadId: string;
  importId: string;
  filename: string;
  size: number;
  contentType: string;
  settingsIdentity: string;
  exp: number;
}
export function issueAttachmentTicket(payload: AttachmentUploadTicket, secret: string): string {
  // No email claim: this token cannot authenticate as a dashboard JWT.
  return signJwt({ ...payload }, secret);
}
export function verifyAttachmentTicket(token: string, secret: string): AttachmentUploadTicket | null {
  const payload = verifySignedJwt(token, secret, Math.floor(Date.now() / 1000));
  return payload?.purpose === "session_attachment_upload" && typeof payload.exp === "number"
    ? payload as unknown as AttachmentUploadTicket : null;
}
