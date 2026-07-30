import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { createLiveCogitoSearchAccessProvider } from "../src/runtime/live_cogito_search_access_provider.js";
import type { SessionResourceAccessRepository } from "../src/session/session_resource_access.js";

describe("live cogito search access provider", () => {
  it("filters event and navigation results through the shared folder access policy", async () => {
    const accessProvider = {
      resolveAccess: vi.fn(async () => ({
        restricted: true,
        allowedFolderIds: ["allowed-root"],
      })),
      requireSessionAccess: vi.fn(),
      requireFolderAccess: vi.fn(),
    };
    const repository = {
      getSessionAccessRecord: vi.fn(async (sessionId: string) => {
        if (sessionId === "allowed-session") {
          return { sessionId, folderId: "allowed-child" };
        }
        if (sessionId === "hidden-session") {
          return { sessionId, folderId: "hidden" };
        }
        return null;
      }),
      listFoldersForAccess: vi.fn(async () => [
        { id: "allowed-root" },
        { id: "allowed-child", parentFolderId: "allowed-root" },
        { id: "hidden" },
      ]),
    } satisfies SessionResourceAccessRepository;
    const provider = createLiveCogitoSearchAccessProvider({
      accessProvider,
      repository,
    });

    const response = await provider.filterResults?.({
      request: {} as FastifyRequest,
      response: {
        results: [
          { session_id: "allowed-session", event_id: 1 },
          { session_id: "hidden-session", event_id: 2 },
          { session_id: "missing-session", event_id: 3 },
        ],
        navigation_results: [
          { kind: "folder", id: "allowed", folder_id: "allowed-child" },
          { kind: "task", id: "hidden", folder_id: "hidden" },
        ],
      },
    });

    expect(response).toEqual({
      results: [{ session_id: "allowed-session", event_id: 1 }],
      navigation_results: [
        { kind: "folder", id: "allowed", folder_id: "allowed-child" },
      ],
    });
    expect(repository.listFoldersForAccess).toHaveBeenCalledOnce();
    expect(repository.getSessionAccessRecord).toHaveBeenCalledTimes(3);
  });
});
