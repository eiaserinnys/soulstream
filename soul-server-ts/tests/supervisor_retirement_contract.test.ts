import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const retiredSurfaceRoots = [
  "soul-server-ts/src",
  "orch-server-ts/src",
  "orch-server/src",
  "packages/soul-common/src",
  "packages/wire-schema/src",
  "packages/wire-schema/generated",
  "unified-dashboard/client",
  ".env.soul-server-ts.example",
];

describe("retired runtime surface", () => {
  it("contains no supervisor subsystem identifiers", () => {
    let matches = "";
    try {
      matches = execFileSync(
        "rg",
        ["-n", "-i", "supervisor", ...retiredSurfaceRoots],
        { cwd: repositoryRoot, encoding: "utf8" },
      );
    } catch (error) {
      const result = error as { status?: number; stdout?: string };
      if (result.status !== 1) throw error;
      matches = result.stdout ?? "";
    }

    expect(matches).toBe("");
  });
});
