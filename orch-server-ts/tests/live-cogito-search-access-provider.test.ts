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
      listFoldersForAccess: vi.fn(async () => []),
      listFoldersForSearchAccess: vi.fn(async () => [
        { id: "allowed-root" },
        { id: "allowed-child", parentFolderId: "allowed-root" },
        { id: "hidden" },
      ]),
    } satisfies SessionResourceAccessRepository;
    const provider = createLiveCogitoSearchAccessProvider({
      accessProvider,
      repository,
    });
    const access = await provider.resolveAccess?.({} as FastifyRequest);

    const response = await provider.filterResults?.({
      request: {} as FastifyRequest,
      access: access!,
      response: {
        results: [
          { session_id: "allowed-session", folder_id: "allowed-child", event_id: 1 },
          { session_id: "hidden-session", folder_id: "hidden", event_id: 2 },
          { session_id: "missing-session", event_id: 3 },
        ],
        session_results: [
          { session_id: "allowed-session", folder_id: "allowed-child", title: "Visible title" },
          { session_id: "hidden-session", folder_id: "hidden", title: "Hidden title" },
        ],
        navigation_results: [
          { kind: "folder", id: "allowed", folder_id: "allowed-child" },
          { kind: "task", id: "hidden", folder_id: "hidden" },
        ],
      },
    });

    expect(response).toEqual({
      results: [{ session_id: "allowed-session", event_id: 1 }],
      session_results: [
        { session_id: "allowed-session", title: "Visible title" },
      ],
      navigation_results: [
        { kind: "folder", id: "allowed", folder_id: "allowed-child" },
      ],
    });
    expect(repository.listFoldersForAccess).not.toHaveBeenCalled();
    expect(repository.listFoldersForSearchAccess).toHaveBeenCalledWith(500);
    expect(access).toEqual({
      restricted: true,
      allowedFolderIds: ["allowed-root", "allowed-child"],
    });
    expect(repository.getSessionAccessRecord).not.toHaveBeenCalled();
  });
});
