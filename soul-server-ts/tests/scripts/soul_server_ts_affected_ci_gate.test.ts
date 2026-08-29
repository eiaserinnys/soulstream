import { readFileSync, readdirSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowsDirectory = fileURLToPath(new URL(
  "../../../.github/workflows/",
  import.meta.url,
));
const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
const vitestConfigPath = fileURLToPath(new URL("../../vitest.config.ts", import.meta.url));

const laneQChangedPaths = [
  "soul-server-ts/src/runtime/claude_runtime_startup_recovery.ts",
  "soul-server-ts/src/task/queued_delivery_transcript_recovery.ts",
  "soul-server-ts/tests/runtime/claude_runtime_startup_recovery.test.ts",
  "soul-server-ts/tests/task/queued_delivery_transcript_finite_recovery.test.ts",
  "soul-server-ts/tests/task/queued_delivery_transcript_rolling_contract.test.ts",
];

const laneQCausalTests = [
  "tests/runtime/claude_runtime_startup_recovery.test.ts",
  "tests/task/queued_delivery_transcript_finite_recovery.test.ts",
];

function matchesOrderedPathFilter(path: string, patterns: string[]): boolean {
  let selected = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith("!");
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    if (matchesGlob(path, pattern)) selected = !excluded;
  }
  return selected;
}

function selectedPullRequestWorkflows(changedPaths: string[]) {
  return readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => ({
      name,
      workflow: parse(readFileSync(`${workflowsDirectory}/${name}`, "utf8")),
    }))
    .filter(({ workflow }) => {
      const patterns = workflow.on?.pull_request?.paths;
      return Array.isArray(patterns) && changedPaths.some((path) =>
        matchesOrderedPathFilter(path, patterns)
      );
    });
}

describe("soul-server-ts affected CI gate", () => {
  it("selects the affected job and runs typecheck plus the broad causal test slice", () => {
    const selected = selectedPullRequestWorkflows(laneQChangedPaths);
    expect(selected.map(({ name, workflow }) => ({
      name,
      jobs: Object.keys(workflow.jobs),
    }))).toEqual([{
      name: "soul-server-ts.yml",
      jobs: ["soul-server-ts"],
    }]);

    const job = selected[0]?.workflow.jobs["soul-server-ts"];
    expect(job).toBeDefined();
    const commands = job.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(commands).toContain("corepack pnpm --dir soul-server-ts typecheck");
    expect(commands).toContain(
      "corepack pnpm --dir soul-server-ts test -- --minWorkers=1 --maxWorkers=2",
    );

    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(packageJson.scripts.test).toBe("vitest run");

    const broadTestInclude = "tests/**/*.test.ts";
    expect(readFileSync(vitestConfigPath, "utf8"))
      .toContain(`include: ["${broadTestInclude}"]`);
    for (const causalTest of laneQCausalTests) {
      expect(matchesGlob(causalTest, broadTestInclude)).toBe(true);
    }
  });
});
