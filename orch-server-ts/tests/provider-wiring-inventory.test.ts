import { describe, expect, it } from "vitest";

import {
  liveProviderWiringInventory,
  shadowRouteCompositionRequirements,
  validateLiveProviderWiringInventory,
  type LiveProviderWiringInventoryEntry,
} from "../src/index.js";

describe("live provider wiring inventory", () => {
  it("covers every shadow route provider requirement exactly once", () => {
    const result = validateLiveProviderWiringInventory({
      requirements: shadowRouteCompositionRequirements,
      inventory: liveProviderWiringInventory,
    });

    expect(result).toMatchObject({
      valid: true,
      missingProviderPaths: [],
      extraProviderPaths: [],
      duplicateProviderPaths: [],
    });
    expect(result.inventoryProviderPaths).toEqual(result.expectedProviderPaths);
  });

  it("fails when a provider owner/path from shadow composition is missing", () => {
    const [firstEntry, ...remainingEntries] = liveProviderWiringInventory;
    const result = validateLiveProviderWiringInventory({
      requirements: shadowRouteCompositionRequirements,
      inventory: remainingEntries,
    });

    expect(result.valid).toBe(false);
    expect(result.missingProviderPaths).toEqual([
      { owner: firstEntry.owner, path: firstEntry.path },
    ]);
  });

  it("fails when inventory contains an extra owner/path", () => {
    const result = validateLiveProviderWiringInventory({
      requirements: shadowRouteCompositionRequirements,
      inventory: [
        ...liveProviderWiringInventory,
        {
          owner: "unknown.owner",
          path: "unknown.provider",
          status: "stub",
          source: "No matching shadow composition requirement.",
          dependencies: [],
          cutoverRisk: "low",
          notes: "Fixture entry used to verify the extra-entry gate.",
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.extraProviderPaths).toEqual([
      { owner: "unknown.owner", path: "unknown.provider" },
    ]);
  });

  it("fails when inventory duplicates an owner/path", () => {
    const [firstEntry] = liveProviderWiringInventory;
    const result = validateLiveProviderWiringInventory({
      requirements: shadowRouteCompositionRequirements,
      inventory: [...liveProviderWiringInventory, firstEntry],
    });

    expect(result.valid).toBe(false);
    expect(result.duplicateProviderPaths).toEqual([
      { owner: firstEntry.owner, path: firstEntry.path, count: 2 },
    ]);
  });

  it("keeps status and risk values constrained to explicit unions", () => {
    const statuses = new Set<LiveProviderWiringInventoryEntry["status"]>(
      liveProviderWiringInventory.map((entry) => entry.status),
    );
    const risks = new Set<LiveProviderWiringInventoryEntry["cutoverRisk"]>(
      liveProviderWiringInventory.map((entry) => entry.cutoverRisk),
    );

    expect([...statuses].sort()).toEqual(["blocked", "implemented", "stub"]);
    expect([...risks].sort()).toEqual(["high", "low", "medium"]);
  });

  it("marks only the completed live provider slices implemented", () => {
    const statusByPath = new Map(
      liveProviderWiringInventory.map((entry) => [
        `${entry.owner}:${entry.path}`,
        entry.status,
      ]),
    );

    expect(statusByPath.get("atom:atomRoutes.configProvider")).toBe("implemented");
    expect(statusByPath.get("public.status:publicStatusRoutes.configProvider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("system.config:systemConfigRoutes.provider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("system.config:systemConfigRoutes.httpClient")).toBe(
      "implemented",
    );
    expect(statusByPath.get("cogito:cogitoRoutes.provider")).toBe("implemented");
    expect(statusByPath.get("cogito:cogitoRoutes.httpClient")).toBe("implemented");
    expect(statusByPath.get("cogito:cogitoRoutes.briefCollector")).toBe(
      "implemented",
    );
    expect(statusByPath.get("execute:executeProxyRoutes.provider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("runbooks:runbookRoutes.httpClient")).toBe(
      "implemented",
    );
    expect(statusByPath.get("auth:authRoutes.userPayloadExtra")).toBe(
      "implemented",
    );
    expect(statusByPath.get("folders:folderRoutes.accessProvider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("folders:folderRoutes.provider")).toBe("implemented");
    expect(
      liveProviderWiringInventory
        .filter((entry) => entry.owner === "admin.users")
        .map((entry) => ({ path: entry.path, status: entry.status })),
    ).toEqual([
      { path: "adminUsersRoutes.provider", status: "implemented" },
    ]);
    expect(
      statusByPath.get("public.status:publicStatusRoutes.folderCountsProvider"),
    ).toBe("implemented");
    expect(statusByPath.get("push:pushRoutes.repository")).toBe("implemented");
    expect(statusByPath.get("push:pushRoutes.resolveJwtUser")).toBe("implemented");
    expect(
      liveProviderWiringInventory
        .filter((entry) => entry.owner === "push")
        .map((entry) => ({ path: entry.path, status: entry.status })),
    ).toEqual([
      { path: "pushRoutes.repository", status: "implemented" },
      { path: "pushRoutes.resolveJwtUser", status: "implemented" },
    ]);
    expect(
      liveProviderWiringInventory
        .filter((entry) => entry.owner === "user.preferences")
        .map((entry) => ({ path: entry.path, status: entry.status })),
    ).toEqual([
      { path: "userPreferencesRoutes.repository", status: "implemented" },
      { path: "userPreferencesRoutes.resolveAuthenticatedEmail", status: "implemented" },
    ]);
    expect(
      liveProviderWiringInventory
        .filter((entry) => entry.owner === "user.background")
        .map((entry) => ({
          path: entry.path,
          status: entry.status,
          dependencies: entry.dependencies,
        })),
    ).toEqual([
      {
        path: "userBackgroundRoutes.repository",
        status: "implemented",
        dependencies: ["db"],
      },
      {
        path: "userBackgroundRoutes.resolveAuthenticatedEmail",
        status: "implemented",
        dependencies: ["auth", "jwt"],
      },
    ]);
    expect(statusByPath.get("board.items:boardItemRoutes.accessProvider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("board.items:boardItemRoutes.provider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("board.assets:boardAssetRoutes.accessProvider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("board.assets:boardAssetRoutes.provider")).toBe(
      "implemented",
    );
    expect(
      statusByPath.get("markdown.documents:markdownDocumentRoutes.accessProvider"),
    ).toBe("implemented");
    expect(statusByPath.get("runbooks:runbookRoutes.accessProvider")).toBe(
      "implemented",
    );
    expect(
      statusByPath.get("node.agent-profiles:nodeAgentProfileRoutes.provider"),
    ).toBe("implemented");
    expect(
      statusByPath.get("node.claude-auth:nodeClaudeAuthRoutes.profileHttpClient"),
    ).toBe("implemented");
    expect(statusByPath.get("node.claude-auth:nodeClaudeAuthRoutes.provider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("node.claude-auth:nodeClaudeAuthRoutes.pkce")).toBe(
      "implemented",
    );
    expect(
      statusByPath.get("node.claude-auth:nodeClaudeAuthRoutes.sessionStore"),
    ).toBe("implemented");
    expect(
      statusByPath.get("node.claude-auth:nodeClaudeAuthRoutes.tokenExchange"),
    ).toBe("implemented");
    expect(statusByPath.get("runbooks:runbookRoutes.provider")).toBe(
      "implemented",
    );
    expect(statusByPath.get("board.yjs-host:runtime.boardYjsHostHttpClient")).toBe(
      "implemented",
    );
  });
});
