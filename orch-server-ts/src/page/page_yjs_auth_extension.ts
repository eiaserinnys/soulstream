import type { Extension, onAuthenticatePayload } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";

import {
  authenticateSocketConnection,
  type SocketAuthConfig,
} from "../auth/socket_auth.js";
import { getPageYjsDocumentName } from "./page_yjs_model.js";

export function createPageYjsAuthExtension(
  auth: SocketAuthConfig,
  logger?: FastifyBaseLogger,
): Extension {
  return {
    extensionName: "soulstream-page-yjs-auth",
    async onAuthenticate(payload: onAuthenticatePayload) {
      const routePageId = (payload.context as { pageId?: unknown } | undefined)?.pageId;
      if (
        typeof routePageId !== "string" ||
        getPageYjsDocumentName(routePageId) !== payload.documentName
      ) {
        throw new Error("Page Yjs route pageId does not match document name");
      }
      const result = await authenticateSocketConnection({
        token: payload.token,
        requestHeaders: payload.requestHeaders,
        config: auth,
      });
      if (result.principal !== undefined) {
        // Hocuspocus keeps this context object on the connection, so a revoked
        // node credential can close exactly the sockets that it authenticated.
        (payload.context as Record<string, unknown>).credentialId =
          result.principal.credential_id;
      }
      logger?.debug(
        {
          documentName: payload.documentName,
          authSource: result.source,
          subject: result.subject,
        },
        "Page Yjs websocket authenticated",
      );
      return { user: result.subject };
    },
  };
}
