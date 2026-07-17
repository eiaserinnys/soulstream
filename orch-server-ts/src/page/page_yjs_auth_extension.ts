import type { Extension, onAuthenticatePayload } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";

import {
  authenticateBoardYjsConnection,
  type BoardYjsAuthConfig,
} from "../board-yjs/board_yjs_auth.js";
import { getPageYjsDocumentName } from "./page_yjs_model.js";

export function createPageYjsAuthExtension(
  auth: BoardYjsAuthConfig,
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
      const result = await authenticateBoardYjsConnection({
        token: payload.token,
        requestHeaders: payload.requestHeaders,
        config: auth,
      });
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
