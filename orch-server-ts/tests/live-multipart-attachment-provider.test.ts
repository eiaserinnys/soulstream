import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import { createLiveMultipartAttachmentOptions } from "../src/runtime/live_multipart_attachment_provider.js";
import type { LiveAttachmentCommandRegistry } from "../src/runtime/live_attachment_route_provider.js";

describe("large attachment session/folder access boundary", () => {
  function harness(existing: boolean) {
    const requireSessionAccess = vi.fn(async () => {});
    const requireFolderAccess = vi.fn(async () => {});
    const options = createLiveMultipartAttachmentOptions({
      resolveStorage: async () => null, resolveEmail: async () => "owner@example.com",
      configProvider: { getConfig: () => ({}), requireConfig: () => "secret" },
      repository: { getSessionAccessRecord: async () => existing ? { sessionId: "existing", folderId: "folder" } : null,
        listFoldersForAccess: async () => [] },
      access: { requireSessionAccess, requireFolderAccess, resolveAccess: async () => ({ restricted: true, allowedFolderIds: ["folder"] }) },
      registry: { getConnectedNode: () => undefined } as unknown as LiveAttachmentCommandRegistry,
      bridge: { sendPendingCommand: vi.fn() },
    });
    return { options, requireSessionAccess, requireFolderAccess };
  }
  const request = {} as FastifyRequest;
  it("keeps the existing session authorization path", async () => {
    const h = harness(true);
    await h.options.requireAccess(request, "existing", null);
    expect(h.requireSessionAccess).toHaveBeenCalledWith({ request, sessionId: "existing" });
    expect(h.requireFolderAccess).not.toHaveBeenCalled();
  });
  it("requires folder access for an authenticated pre-session UUID", async () => {
    const h = harness(false);
    await h.options.requireAccess(request, "bed05238-498d-4f76-aebb-c0eaa236cda5", "folder");
    expect(h.requireFolderAccess).toHaveBeenCalledWith({ request, folderId: "folder" });
    h.requireFolderAccess.mockRejectedValueOnce(Object.assign(new Error("Folder access denied"), { statusCode: 403 }));
    await expect(h.options.requireAccess(request, "bed05238-498d-4f76-aebb-c0eaa236cda5", "denied")).rejects.toMatchObject({ statusCode: 403 });
  });
  it("does not authorize a pre-session upload without a folder or with a non-UUID ID", async () => {
    const h = harness(false);
    await expect(h.options.requireAccess(request, "bed05238-498d-4f76-aebb-c0eaa236cda5", null)).rejects.toMatchObject({ statusCode: 400 });
    await expect(h.options.requireAccess(request, "client-selected", "folder")).rejects.toMatchObject({ statusCode: 400 });
    expect(h.requireFolderAccess).not.toHaveBeenCalled();
  });
});
