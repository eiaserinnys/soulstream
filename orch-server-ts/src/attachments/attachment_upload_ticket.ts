import { isUuid } from "../http/uuid.js";
import { signJwt, verifySignedJwt } from "../runtime/live_auth_route_provider.js";
import type { UploadMode } from "./attachment_upload_http.js";

export const LARGE_ATTACHMENT_MAX_SIZE = 5 * 1024 ** 3;
export const LARGE_ATTACHMENT_PART_SIZE = 16 * 1024 ** 2;
export const ATTACHMENT_TICKET_SECONDS = 3600;
const ORIGINALS_STORAGE_PREFIX = "session-attachments/originals";
const TRANSFERS_STORAGE_PREFIX = "session-attachments/transfers";
export interface AttachmentUploadTicket {
  purpose: "session_attachment_upload";
  sub: string;
  sessionId: string;
  folderId: string | null;
  nodeId: string | null;
  storageKey: string;
  uploadId: string;
  importId: string;
  filename: string;
  size: number;
  contentType: string;
  settingsIdentity: string;
  exp: number;
  responseContract?: UploadMode;
  checksumSha256?: string;
}
export function issueAttachmentTicket(payload: AttachmentUploadTicket, secret: string): string {
  // No email claim: this token cannot authenticate as a dashboard JWT.
  return signJwt({ ...payload }, secret);
}
export function verifyAttachmentTicket(token: string, secret: string): AttachmentUploadTicket | null {
  const payload = verifySignedJwt(token, secret, Math.floor(Date.now() / 1000));
  if (payload?.purpose !== "session_attachment_upload") return null;
  const contract = payload.responseContract;
  if (contract !== undefined && !isUploadMode(contract)) return null;
  const mode: UploadMode = contract === undefined ? "legacy" : contract;
  if (!nonEmptyString(payload.sub) || !nonEmptyString(payload.sessionId)
    || !nonEmptyString(payload.filename) || !nonEmptyString(payload.contentType)
    || !nonEmptyString(payload.settingsIdentity) || !nonEmptyString(payload.uploadId)) return null;
  if (!(payload.folderId === null || nonEmptyString(payload.folderId))) return null;
  if (!isUuid(payload.importId)) return null;
  if (!Number.isSafeInteger(payload.size) || (payload.size as number) < 1
    || (payload.size as number) > LARGE_ATTACHMENT_MAX_SIZE) return null;
  if (!Number.isInteger(payload.exp)) return null;
  if (payload.checksumSha256 !== undefined
    && !(typeof payload.checksumSha256 === "string" && /^[0-9a-f]{64}$/i.test(payload.checksumSha256))) return null;
  if (mode === "legacy") {
    if (!nonEmptyString(payload.nodeId)) return null;
  } else if (!(payload.nodeId === null || nonEmptyString(payload.nodeId))) return null;
  if (!storageKeyMatches(payload.storageKey, payload.importId, contract !== undefined)) return null;
  return payload as unknown as AttachmentUploadTicket;
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isUploadMode(value: unknown): value is UploadMode {
  return value === "legacy" || value === "id-v1";
}
function storageKeyMatches(storageKey: unknown, importId: string, explicitContract: boolean): boolean {
  if (typeof storageKey !== "string") return false;
  if (storageKey === `${ORIGINALS_STORAGE_PREFIX}/${importId}`) return true;
  // transfer keys belong only to the pre-contract legacy shape; an explicit
  // ticket contract (including legacy) must use the originals prefix.
  return !explicitContract && storageKey === `${TRANSFERS_STORAGE_PREFIX}/${importId}`;
}
