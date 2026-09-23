import { visibleBoardFolderIds } from "../board/board_access.js";
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

const SEARCH_ACCESS_STATEMENT_TIMEOUT_MS = 500;

export function createLiveCogitoSearchAccessProvider(
  options: CreateLiveCogitoSearchAccessProviderOptions,
): CogitoSearchAccessProvider {
  return {
    async resolveAccess(request) {
      const access = await options.accessProvider.resolveAccess({ request });
      if (!access.restricted) return { restricted: false };
      const folders = options.repository.listFoldersForSearchAccess === undefined
        ? await options.repository.listFoldersForAccess()
        : await options.repository.listFoldersForSearchAccess(SEARCH_ACCESS_STATEMENT_TIMEOUT_MS);
      return {
        restricted: true,
        allowedFolderIds: [...visibleBoardFolderIds(access, folders)],
      };
    },
    async filterResults({ response, access }) {
      const allowedFolderIds = new Set(access.allowedFolderIds ?? []);
      // The live search provider selects folder_id from its joined session row and
      // applies this same allow-list in every candidate SQL source. Rechecking
      // session ownership with one query per hit would run unbounded post-search work.
      const filterSessionResult = (result: CogitoSearchResult): CogitoSearchResult | null => {
        const sessionId = resultSessionId(result);
        const folderId = resultFolderId(result);
        if (sessionId === null || folderId === null || !allowedFolderIds.has(folderId)) {
          return null;
        }
        const { folder_id: _folderId, folderId: _folderIdAlias, ...publicResult } = result;
        return publicResult;
      };
      return {
        ...response,
        results: response.results.flatMap((result) => {
          const filtered = filterSessionResult(result);
          return filtered === null ? [] : [filtered];
        }),
        ...(response.session_results === undefined
          ? {}
          : {
            session_results: response.session_results.flatMap((result) => {
              const filtered = filterSessionResult(result);
              return filtered === null ? [] : [filtered];
            }),
          }),
        navigation_results: response.navigation_results.filter((result) =>
          allowedFolderIds.has(resultFolderId(result) ?? ""),
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
