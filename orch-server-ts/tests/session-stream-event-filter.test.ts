import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createSessionStreamEventFilter,
  type SessionResourceAccessRepository,
  type SessionStreamEvent,
} from "../src/index.js";

describe("session stream event access filter", () => {
  const request = {} as FastifyRequest;

  it("keeps only restricted user's allowed folder and descendant session events", async () => {
    const { filter } = createFilterHarness({
      access: { restricted: true, allowedFolderIds: ["root"] },
      folders: [
        { id: "root", parentFolderId: null },
        { id: "child", parentFolderId: "root" },
        { id: "denied", parentFolderId: null },
      ],
    });

    await expect(
      filter(request, {
        type: "session_updated",
        agent_session_id: "allowed",
        folderId: "child",
      }),
    ).resolves.toMatchObject({ agent_session_id: "allowed" });
    await expect(
      filter(request, {
        type: "session_updated",
        agent_session_id: "denied",
        folderId: "denied",
      }),
    ).resolves.toBeNull();
  });

  it("uses DB session rows when event payload lacks folder or session type", async () => {
    const { filter, repository } = createFilterHarness({
      access: { restricted: true, allowedFolderIds: ["visible"] },
      folders: [
        { id: "visible", parentFolderId: null },
        { id: "hidden", parentFolderId: null, settings: { excludeFromFeed: true } },
      ],
      sessionRows: new Map([
        ["allowed", { sessionId: "allowed", folderId: "visible", sessionType: "claude" }],
        ["hidden", { sessionId: "hidden", folderId: "hidden", sessionType: "claude" }],
        ["llm", { sessionId: "llm", folderId: "visible", sessionType: "llm" }],
      ]),
    });

    await expect(
      filter(request, { type: "session_updated", agent_session_id: "allowed" }),
    ).resolves.toMatchObject({ agent_session_id: "allowed" });
    await expect(
      filter(request, { type: "session_deleted", agent_session_id: "hidden" }),
    ).resolves.toBeNull();
    await expect(
      filter(request, { type: "session_updated", agent_session_id: "llm" }, {
        feedOnly: true,
      }),
    ).resolves.toBeNull();
    expect(repository.getSessionAccessRecord).toHaveBeenCalledWith("allowed");
    expect(repository.getSessionAccessRecord).toHaveBeenCalledWith("hidden");
    expect(repository.getSessionAccessRecord).toHaveBeenCalledWith("llm");
  });

  it("filters feed-only session events by excluded folders and llm session type", async () => {
    const { filter } = createFilterHarness({
      access: { restricted: false },
      folders: [
        { id: "visible", parentFolderId: null },
        { id: "hidden", parentFolderId: null, settings: { excludeFromFeed: true } },
      ],
    });

    await expect(
      filter(request, {
        type: "session_created",
        session: {
          agentSessionId: "hidden-session",
          folderId: "hidden",
          sessionType: "claude",
        },
      }, { feedOnly: true }),
    ).resolves.toBeNull();
    await expect(
      filter(request, {
        type: "session_created",
        session: {
          agentSessionId: "llm-session",
          folderId: "visible",
          sessionType: "llm",
        },
      }, { feedOnly: true }),
    ).resolves.toBeNull();
    await expect(
      filter(request, {
        type: "session_created",
        session: {
          agentSessionId: "visible-session",
          folderId: "visible",
          sessionType: "claude",
        },
      }, { feedOnly: true }),
    ).resolves.toMatchObject({ type: "session_created" });
  });

  it("scopes catalog_updated folders and assignments by restricted and feed-only rules", async () => {
    const { filter } = createFilterHarness({
      access: { restricted: true, allowedFolderIds: ["root"] },
      folders: [],
    });
    const event: SessionStreamEvent = {
      type: "catalog_updated",
      catalog: {
        folders: [
          { id: "root", parentFolderId: null },
          { id: "child", parentFolderId: "root" },
          { id: "hidden-child", parentFolderId: "root", settings: { excludeFromFeed: true } },
          { id: "denied", parentFolderId: null },
        ],
        sessions: {
          allowed: { folderId: "child" },
          hidden: { folderId: "hidden-child" },
          denied: { folderId: "denied" },
        },
      },
    };

    const filtered = await filter(request, event, { feedOnly: true });

    expect(filtered).toEqual({
      type: "catalog_updated",
      catalog: {
        folders: [
          { id: "root", parentFolderId: null },
          { id: "child", parentFolderId: "root" },
          { id: "hidden-child", parentFolderId: "root", settings: { excludeFromFeed: true } },
        ],
        sessions: {
          allowed: { folderId: "child" },
        },
      },
    });
  });
});

function createFilterHarness(options: {
  access: { restricted: boolean; allowedFolderIds?: readonly string[] };
  folders: Array<{ id: string; parentFolderId?: string | null; settings?: unknown }>;
  sessionRows?: Map<
    string,
    { sessionId: string; folderId: string | null; sessionType?: string | null }
  >;
}) {
  const access = {
    restricted: options.access.restricted,
    allowedFolderIds: options.access.allowedFolderIds ?? [],
  };
  const accessProvider = {
    resolveAccess: vi.fn(async () => access),
  };
  const repository = {
    getSessionAccessRecord: vi.fn(async (sessionId: string) =>
      options.sessionRows?.get(sessionId) ?? null
    ),
    listFoldersForAccess: vi.fn(async () => options.folders),
  } satisfies SessionResourceAccessRepository;
  return {
    repository,
    filter: createSessionStreamEventFilter({ accessProvider, repository }),
  };
}
