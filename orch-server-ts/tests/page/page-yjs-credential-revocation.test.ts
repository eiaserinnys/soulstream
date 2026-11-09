import { describe, expect, it, vi } from "vitest";

import type {
  NodeCredentialResolver,
  NodePrincipal,
} from "../../src/node_credentials/types.js";
import { createPageYjsAuthExtension } from "../../src/page/page_yjs_auth_extension.js";
import { PageYjsService } from "../../src/page/page_service.js";

const PRINCIPAL: NodePrincipal = {
  credential_id: "credential-1",
  node_id: "fake-node",
  company_pc: false,
};

function resolverFor(principal: NodePrincipal | null): NodeCredentialResolver {
  return {
    resolve: (token) => (token === "node-token" ? principal : null),
    onRevoked: () => () => {},
  };
}

describe("page Yjs node credential binding", () => {
  it("stamps the credential id into the authenticated connection context", async () => {
    const extension = createPageYjsAuthExtension({
      authBearerToken: "service-token",
      environment: "production",
      nodeCredentials: resolverFor(PRINCIPAL),
      dashboardAuthEnabled: false,
      resolveDashboardUserFromHeaders: async () => null,
    });
    const context: Record<string, unknown> = { pageId: "page-1" };

    const result = await extension.onAuthenticate?.({
      token: "node-token",
      requestHeaders: {},
      documentName: "page:page-1",
      context,
    } as never);

    expect(result).toEqual({ user: "bearer" });
    expect(context.credentialId).toBe("credential-1");
  });

  it("leaves the connection context unstamped for the shared service token", async () => {
    const extension = createPageYjsAuthExtension({
      authBearerToken: "service-token",
      environment: "production",
      nodeCredentials: resolverFor(PRINCIPAL),
      dashboardAuthEnabled: false,
      resolveDashboardUserFromHeaders: async () => null,
    });
    const context: Record<string, unknown> = { pageId: "page-1" };

    await extension.onAuthenticate?.({
      token: "service-token",
      requestHeaders: {},
      documentName: "page:page-1",
      context,
    } as never);

    expect(context.credentialId).toBeUndefined();
  });

  it("closes only the connections authenticated by the revoked credential", () => {
    const service = new PageYjsService({ repository: {} as never });
    const revokedClose = vi.fn();
    const otherCredentialClose = vi.fn();
    const legacyClose = vi.fn();
    const documents = (
      service as unknown as { hocuspocus: { documents: Map<string, unknown> } }
    ).hocuspocus.documents;
    documents.set("page:page-1", {
      getConnections: () => [
        { context: { credentialId: "credential-1" }, close: revokedClose },
        { context: { credentialId: "credential-2" }, close: otherCredentialClose },
        { context: {}, close: legacyClose },
      ],
    });

    expect(service.closeConnectionsForCredential("credential-1")).toBe(1);
    expect(revokedClose).toHaveBeenCalledWith({
      code: 1008,
      reason: "node credential revoked",
    });
    expect(otherCredentialClose).not.toHaveBeenCalled();
    expect(legacyClose).not.toHaveBeenCalled();
  });
});
