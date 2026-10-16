import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_TICKET_SECONDS, LARGE_ATTACHMENT_MAX_SIZE,
  issueAttachmentTicket, verifyAttachmentTicket, type AttachmentUploadTicket,
} from "../src/attachments/attachment_upload_ticket.js";
import { createLiveAuthJwtHelper, signJwt } from "../src/runtime/live_auth_route_provider.js";

const SECRET = "test-secret";
const IMPORT_ID = "5f8d2c1a-3b4e-4c5d-8e9f-0a1b2c3d4e5f";
const SESSION_ID = "bed05238-498d-4f76-aebb-c0eaa236cda5";
const future = () => Math.floor(Date.now() / 1000) + ATTACHMENT_TICKET_SECONDS;

function legacyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    purpose: "session_attachment_upload", sub: "owner@example.com", sessionId: SESSION_ID,
    folderId: null, nodeId: "worker", storageKey: `session-attachments/transfers/${IMPORT_ID}`,
    uploadId: "r2-upload", importId: IMPORT_ID, filename: "large.zip", size: 1024,
    contentType: "application/zip", settingsIdentity: "settings-v1", exp: future(), ...overrides,
  };
}
function idV1Payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return legacyPayload({
    nodeId: null, responseContract: "id-v1", storageKey: `session-attachments/originals/${IMPORT_ID}`, ...overrides,
  });
}

describe("attachment upload ticket verification", () => {
  it("accepts a legacy ticket signed with the transfer storage key", () => {
    const ticket = issueAttachmentTicket(legacyPayload() as unknown as AttachmentUploadTicket, SECRET);
    expect(verifyAttachmentTicket(ticket, SECRET)).toMatchObject({
      purpose: "session_attachment_upload", nodeId: "worker", uploadId: "r2-upload",
    });
    expect(verifyAttachmentTicket(ticket, SECRET)?.responseContract).toBeUndefined();
  });
  it("accepts an id-v1 ticket with a null node id and originals key", () => {
    const ticket = issueAttachmentTicket(idV1Payload() as unknown as AttachmentUploadTicket, SECRET);
    const verified = verifyAttachmentTicket(ticket, SECRET);
    expect(verified).toMatchObject({ nodeId: null, responseContract: "id-v1" });
  });
  it("accepts an explicit legacy contract only from the originals key", () => {
    const ok = issueAttachmentTicket(legacyPayload({
      responseContract: "legacy", storageKey: `session-attachments/originals/${IMPORT_ID}`,
    }) as unknown as AttachmentUploadTicket, SECRET);
    expect(verifyAttachmentTicket(ok, SECRET)).not.toBeNull();
    const transfer = issueAttachmentTicket(legacyPayload({
      responseContract: "legacy", storageKey: `session-attachments/transfers/${IMPORT_ID}`,
    }) as unknown as AttachmentUploadTicket, SECRET);
    expect(verifyAttachmentTicket(transfer, SECRET)).toBeNull();
  });
  it("rejects an id-v1 ticket that keeps the legacy transfer key", () => {
    const ticket = issueAttachmentTicket(idV1Payload({
      storageKey: `session-attachments/transfers/${IMPORT_ID}`,
    }) as unknown as AttachmentUploadTicket, SECRET);
    expect(verifyAttachmentTicket(ticket, SECRET)).toBeNull();
  });
  it("rejects a ticket whose payload was altered after signing", () => {
    const ticket = issueAttachmentTicket(legacyPayload() as unknown as AttachmentUploadTicket, SECRET);
    const [header, payload, signature] = ticket.split(".");
    const altered = JSON.parse(Buffer.from(payload!, "base64url").toString());
    altered.size = LARGE_ATTACHMENT_MAX_SIZE;
    const forged = `${header}.${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${signature}`;
    expect(verifyAttachmentTicket(forged, SECRET)).toBeNull();
  });
  it("rejects a ticket signed with another secret", () => {
    const ticket = signJwt(legacyPayload(), "other-secret");
    expect(verifyAttachmentTicket(ticket, SECRET)).toBeNull();
  });
  it("rejects an expired ticket", () => {
    const ticket = signJwt(legacyPayload({ exp: Math.floor(Date.now() / 1000) - 10 }), SECRET);
    expect(verifyAttachmentTicket(ticket, SECRET)).toBeNull();
  });
  it("rejects missing or wrong-typed required fields", () => {
    const cases: Record<string, unknown>[] = [
      { purpose: "other" }, { filename: undefined }, { folderId: undefined }, { sub: "" },
      { contentType: undefined }, { settingsIdentity: undefined }, { uploadId: undefined },
      { importId: "not-a-uuid" }, { size: 0 }, { size: LARGE_ATTACHMENT_MAX_SIZE + 1 },
      { size: 1.5 }, { exp: "soon" }, { checksumSha256: "abc" }, { responseContract: "v2" },
      { nodeId: null }, { nodeId: "" }, { storageKey: `session-attachments/evil/${IMPORT_ID}` },
    ];
    for (const overrides of cases) {
      const ticket = signJwt(legacyPayload(overrides), SECRET);
      expect(verifyAttachmentTicket(ticket, SECRET), JSON.stringify(overrides)).toBeNull();
    }
  });
  it("carries an optional checksum through verification", () => {
    const sha = "a".repeat(64);
    const ticket = issueAttachmentTicket(legacyPayload({ checksumSha256: sha }) as unknown as AttachmentUploadTicket, SECRET);
    expect(verifyAttachmentTicket(ticket, SECRET)?.checksumSha256).toBe(sha);
  });
  it("cannot be exchanged for a dashboard identity", async () => {
    const ticket = issueAttachmentTicket(legacyPayload() as unknown as AttachmentUploadTicket, SECRET);
    const jwt = createLiveAuthJwtHelper({ configProvider: {
      getConfig: () => ({}), requireConfig: () => SECRET,
    } });
    expect(await jwt.verifyToken(ticket)).toBeNull();
  });
});
