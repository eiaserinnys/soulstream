import { isBoardFolderAllowed } from "../board/board_access.js";
import type {
  CogitoSearchAccessProvider,
  CogitoSearchResult,
} from "../cogito/cogito_routes.js";
import type {
  SessionResourceAccessProvider,
  SessionResourceAccessRepository,
} from "../session/session_resource_access.js";

export type CreateLiveCogitoSearchAccessProviderOptions = {
  readonly accessProvider: SessionResourceAccessProvider;
  readonly repository: SessionResourceAccessRepository;
};

export function createLiveCogitoSearchAccessProvider(
  options: CreateLiveCogitoSearchAccessProviderOptions,
): CogitoSearchAccessProvider {
  return {
    resolveAccess: async (request) => options.accessProvider.resolveAccess({ request }),
    async filterResults({ request, response }) {
      const access = await options.accessProvider.resolveAccess({ request });
      const folders = await options.repository.listFoldersForAccess();
      const results = [];
      for (const result of response.results) {
        const sessionId = resultSessionId(result);
        if (sessionId === null) continue;
        const session = await options.repository.getSessionAccessRecord(sessionId);
        if (
          session !== null &&
          isBoardFolderAllowed(access, folders, session.folderId)
        ) {
          results.push(result);
        }
      }
      return {
        results,
        navigation_results: response.navigation_results.filter((result) =>
          isBoardFolderAllowed(access, folders, resultFolderId(result))
        ),
      };
    },
  };
}

function resultSessionId(result: CogitoSearchResult): string | null {
  const value = result.session_id ?? result.sessionId;
  return typeof value === "string" ? value : null;
}

function resultFolderId(result: Record<string, unknown>): string | null {
  const value = result.folder_id ?? result.folderId;
  return typeof value === "string" ? value : null;
}
