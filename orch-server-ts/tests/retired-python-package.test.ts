import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("retired soul-common package", () => {
  it("keeps the portrait asset in the TypeScript orchestrator and no Python package", () => {
    expect(existsSync(path.join(repositoryRoot, "orch-server-ts/assets/portraits/system.png"))).toBe(true);
    expect(existsSync(path.join(repositoryRoot, "packages/soul-common"))).toBe(false);
  });
});

describe("retired shadow orchestrator", () => {
  it("does not retain the parity app or its test harness", () => {
    expect(existsSync(path.join(repositoryRoot, "orch-server-ts/src/runtime/shadow_app.ts"))).toBe(false);
    expect(existsSync(path.join(repositoryRoot, "orch-server-ts/src/contract/parity.ts"))).toBe(false);
    expect(existsSync(path.join(repositoryRoot, "orch-server-ts/tests/shadow-runtime-composition.test.ts"))).toBe(false);
  });
});
