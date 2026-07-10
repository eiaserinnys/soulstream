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
    expect(result.unresolvedProviderPaths).toEqual([]);
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

  it("fails when inventory regresses a factory-provided path to blocked", () => {
    const blockedPath = { owner: "attachments", path: "attachmentRoutes.transport" };
    const regressedInventory = liveProviderWiringInventory.map((entry) =>
      entry.owner === blockedPath.owner && entry.path === blockedPath.path
        ? { ...entry, status: "blocked" as const }
        : entry,
    );
    const result = validateLiveProviderFactoryInventoryAlignment({
      inventory: regressedInventory,
      factoryProviderPaths: liveFactoryImplementedProviderPaths,
    });

    expect(result.blockedFactoryProviderPaths).toEqual([
      expect.objectContaining({
        owner: "attachments",
        path: "attachmentRoutes.transport",
        status: "blocked",
      }),
    ]);
  });

  it.each(["stub", "blocked"] as const)(
    "fails the cutover gate when any inventory path regresses to %s",
    (status) => {
      const [regressedPath] = liveProviderWiringInventory;
      const regressedInventory = liveProviderWiringInventory.map((entry) =>
        entry.owner === regressedPath.owner && entry.path === regressedPath.path
          ? { ...entry, status }
          : entry,
      );

      const result = validateLiveProviderFactoryInventoryAlignment({
        inventory: regressedInventory,
        factoryProviderPaths: liveFactoryImplementedProviderPaths,
      });

      expect(result.valid).toBe(false);
      expect(result.unresolvedProviderPaths).toEqual([
        expect.objectContaining({
          owner: regressedPath.owner,
          path: regressedPath.path,
          status,
        }),
      ]);
    },
  );
});
