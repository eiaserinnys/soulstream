import { describe, expect, it } from "vitest";

import {
  liveFactoryImplementedProviderPaths,
  liveProviderWiringInventory,
  validateLiveProviderFactoryInventoryAlignment,
} from "../src/index.js";

describe("live provider factory inventory", () => {
  it("keeps the factory provided paths aligned with implemented inventory entries", () => {
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: liveFactoryImplementedProviderPaths,
    });

    expect(result.missingImplementedProviderPaths).toEqual([]);
    expect(result.extraFactoryProviderPaths).toEqual([]);
    expect(result.blockedFactoryProviderPaths).toEqual([]);
    expect(result.implementedInventoryProviderPaths).toEqual(
      liveFactoryImplementedProviderPaths,
    );
    expect(result.unresolvedProviderPaths).toEqual([
      expect.objectContaining({
        owner: "attachments",
        path: "attachmentRoutes.transport",
        status: "blocked",
      }),
    ]);
  });

  it("fails when inventory marks a path implemented but the factory omits it", () => {
    const [firstPath, ...remainingFactoryPaths] = liveFactoryImplementedProviderPaths;
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: remainingFactoryPaths,
    });

    expect(result.missingImplementedProviderPaths).toEqual([firstPath]);
  });

  it("fails when the factory provides a path absent from inventory", () => {
    const extraPath = { owner: "unknown.owner", path: "unknown.provider" };
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: [...liveFactoryImplementedProviderPaths, extraPath],
    });

    expect(result.extraFactoryProviderPaths).toEqual([extraPath]);
  });

  it("fails when the factory tries to provide a blocked path", () => {
    const blockedPath = { owner: "attachments", path: "attachmentRoutes.transport" };
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: liveProviderWiringInventory,
      factoryProviderPaths: [...liveFactoryImplementedProviderPaths, blockedPath],
    });

    expect(result.blockedFactoryProviderPaths).toEqual([
      expect.objectContaining({
        owner: "attachments",
        path: "attachmentRoutes.transport",
        status: "blocked",
      }),
    ]);
  });
});
