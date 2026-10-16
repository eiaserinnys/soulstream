import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { AuthJwtHelper } from "../src/auth/auth_routes.js";
import { createLiveAuthenticatedUserResolvers } from "../src/runtime/live_authenticated_user_resolver.js";
import { createLiveAttachmentUploadOptions } from "../src/runtime/live_attachment_upload_provider.js";
import type { AttachmentReadRouteOptions } from "../src/attachments/attachment_read_routes.js";

const SESSION_UUID = "bed05238-498d-4f76-aebb-c0eaa236cda5";

function request(headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): FastifyRequest {
  return { headers, ...extra } as unknown as FastifyRequest;
}

function harness(options: { existing?: boolean; folders?: Array<{ id: string }> } = {}) {
  const jwt: AuthJwtHelper = {
    issueToken: vi.fn(async () => "unused"),
    verifyToken: vi.fn(async (token) => ({
      "cookie-jwt": { email: "Owner@Example.com " },
      "native-jwt": { email: "native@example.com" },
      "blank-jwt": { email: "   " },
    } as Record<string, { email: string }>)[token] ?? null),
  };
  const resolvers = createLiveAuthenticatedUserResolvers({ jwt });
  const readActor = vi.fn(async () => ({ kind: "user", email: "owner@example.com" }));
  const metadata = vi.fn(async () => ({ descriptor: {}, upload_status: "pending" }));
  const readOptions = { resolveActor: readActor, service: { metadata } } as unknown as AttachmentReadRouteOptions;
  const requireSessionAccess = vi.fn(async () => {});
  const requireFolderAccess = vi.fn(async () => {});
  const getSessionAccessRecord = vi.fn(async () => options.existing ? { sessionId: SESSION_UUID, folderId: "folder" } : null);
  const listFoldersForAccess = vi.fn(async () => options.folders ?? [{ id: "folder" }]);
  const getOwnedUpload = vi.fn(async () => null);
  const resolveBinding = vi.fn(async () => null);
  const uploadOptions = createLiveAttachmentUploadOptions({
    resolveEmail: resolvers.resolveEmail,
    readOptions,
    repository: { getSessionAccessRecord, listFoldersForAccess },
    access: { requireSessionAccess, requireFolderAccess, resolveAccess: vi.fn() },
    commits: { putSmall: vi.fn(), initMultipart: vi.fn(), completeMultipart: vi.fn(), abortMultipart: vi.fn() } as never,
    commitRepository: { getOwnedUpload } as never,
    resolveBinding,
  });
  return {
    uploadOptions, readActor, metadata, requireSessionAccess, requireFolderAccess,
    getSessionAccessRecord, listFoldersForAccess, getOwnedUpload, resolveBinding,
  };
}

describe("live attachment upload provider", () => {
  it("resolves a dashboard cookie user through the read actor", async () => {
    const h = harness();
    const actor = await h.uploadOptions.resolveActor(request({ cookie: "other=1; soul_dashboard_auth=cookie-jwt" }));
    expect(actor).toMatchObject({ kind: "user", email: "owner@example.com" });
    expect(h.readActor).toHaveBeenCalledTimes(1);
  });
  it("resolves a native bearer user", async () => {
    const h = harness();
    await expect(h.uploadOptions.resolveActor(request({ authorization: "Bearer native-jwt" })))
      .resolves.toMatchObject({ kind: "user" });
  });
  it("returns null without consulting the read actor when unauthenticated", async () => {
    const h = harness();
    await expect(h.uploadOptions.resolveActor(request())).resolves.toBeNull();
    await expect(h.uploadOptions.resolveActor(request({ cookie: "soul_dashboard_auth=blank-jwt" }))).resolves.toBeNull();
    expect(h.readActor).not.toHaveBeenCalled();
  });
  it("ignores forged caller_info and query identity", async () => {
    const h = harness();
    const actor = await h.uploadOptions.resolveActor(request({}, {
      body: { caller_info: { email: "attacker@evil.example", source: "agent" } },
      query: { email: "attacker@evil.example" },
    }));
    expect(actor).toBeNull();
    expect(h.readActor).not.toHaveBeenCalled();
  });
  it("exposes the read service metadata as owner metadata", () => {
    const h = harness();
    expect(h.uploadOptions.ownerMetadata).toBe(h.metadata);
  });

  it("authorizes an existing session and records session provenance", async () => {
    const h = harness({ existing: true });
    const registration = await h.uploadOptions.requireRegistration(request(), {
      actor: { kind: "user", email: "owner@example.com" }, sessionId: SESSION_UUID,
      folderId: null, mode: "legacy", small: false,
    });
    expect(registration).toEqual({
      registrationScope: { type: "session", id: SESSION_UUID },
      sourceNodeId: null, sourceSessionId: SESSION_UUID, outputCommandId: null,
    });
    expect(h.requireSessionAccess).toHaveBeenCalledWith({ request: expect.anything(), sessionId: SESSION_UUID, accessEmail: "owner@example.com" });
    expect(h.requireFolderAccess).not.toHaveBeenCalled();
  });
  it("checks folder access for an existing session with an explicit folder", async () => {
    const h = harness({ existing: true });
    await h.uploadOptions.requireRegistration(request(), {
      actor: { kind: "user", email: "owner@example.com" }, sessionId: SESSION_UUID,
      folderId: "folder", mode: "legacy", small: false,
    });
    expect(h.requireFolderAccess).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder", accessEmail: "owner@example.com" }));
  });
  it("rejects a folder that does not exist before any ACL or storage work", async () => {
    const h = harness({ folders: [] });
    await expect(h.uploadOptions.requireRegistration(request(), {
      actor: { kind: "user", email: "owner@example.com" }, sessionId: SESSION_UUID,
      folderId: "ghost", mode: "legacy", small: false,
    })).rejects.toMatchObject({ statusCode: 404, code: "folder_not_found" });
    expect(h.requireFolderAccess).not.toHaveBeenCalled();
    expect(h.resolveBinding).not.toHaveBeenCalled();
    expect(h.getOwnedUpload).not.toHaveBeenCalled();
  });
  it("scopes a pre-session UUID upload to the folder", async () => {
    const h = harness();
    const registration = await h.uploadOptions.requireRegistration(request(), {
      actor: { kind: "user", email: "owner@example.com" }, sessionId: SESSION_UUID,
      folderId: "folder", mode: "id-v1", small: false,
    });
    expect(registration.registrationScope).toEqual({ type: "folder", id: "folder" });
    expect(registration.sourceNodeId).toBeNull();
    expect(h.requireSessionAccess).not.toHaveBeenCalled();
    expect(h.requireFolderAccess).toHaveBeenCalledTimes(1);
  });
  it("stages a legacy small draft without a scope", async () => {
    const h = harness();
    const registration = await h.uploadOptions.requireRegistration(request(), {
      actor: { kind: "user", email: "owner@example.com" }, sessionId: SESSION_UUID,
      folderId: null, mode: "legacy", small: true,
    });
    expect(registration.registrationScope).toBeNull();
    expect(h.requireFolderAccess).not.toHaveBeenCalled();
  });
  it("requires a folder for id-v1 or large uploads and rejects a non-UUID pre-session id", async () => {
    const h = harness();
    const base = { actor: { kind: "user", email: "owner@example.com" } as const, folderId: null, sessionId: SESSION_UUID };
    await expect(h.uploadOptions.requireRegistration(request(), { ...base, mode: "id-v1", small: false }))
      .rejects.toMatchObject({ statusCode: 400, code: "invalid_upload" });
    await expect(h.uploadOptions.requireRegistration(request(), { ...base, mode: "legacy", small: false }))
      .rejects.toMatchObject({ statusCode: 400, code: "invalid_upload" });
    await expect(h.uploadOptions.requireRegistration(request(), {
      ...base, sessionId: "client-selected", folderId: "folder", mode: "legacy", small: true,
    })).rejects.toMatchObject({ statusCode: 400, code: "invalid_upload" });
    await expect(h.uploadOptions.requireRegistration(request(), { ...base, sessionId: "  ", mode: "legacy", small: true }))
      .rejects.toMatchObject({ statusCode: 400, code: "invalid_upload" });
  });
  it("propagates folder ACL denial status before storage access", async () => {
    const h = harness();
    h.requireFolderAccess.mockRejectedValueOnce(Object.assign(new Error("Folder access denied"), { statusCode: 403 }));
    await expect(h.uploadOptions.requireRegistration(request(), {
      actor: { kind: "user", email: "owner@example.com" }, sessionId: SESSION_UUID,
      folderId: "folder", mode: "id-v1", small: false,
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.resolveBinding).not.toHaveBeenCalled();
    expect(h.getOwnedUpload).not.toHaveBeenCalled();
  });
  it("propagates session ACL denial status", async () => {
    const h = harness({ existing: true });
    h.requireSessionAccess.mockRejectedValueOnce(Object.assign(new Error("Session access denied"), { statusCode: 403 }));
    await expect(h.uploadOptions.requireRegistration(request(), {
      actor: { kind: "user", email: "owner@example.com" }, sessionId: SESSION_UUID,
      folderId: null, mode: "legacy", small: false,
    })).rejects.toMatchObject({ statusCode: 403 });
  });
});
