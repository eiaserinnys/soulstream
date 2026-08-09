import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = fileURLToPath(new URL(
  "../../../.github/workflows/test-install.yml",
  import.meta.url,
));
const gitAttributesPath = fileURLToPath(new URL(
  "../../../.gitattributes",
  import.meta.url,
));
const databaseTestFiles = [
  "release_executor.test.ts",
  "migration_runner.test.ts",
  "apply_schema.test.ts",
];

describe("database release CI contract", () => {
  it("keeps executable database release modules LF-normalized on Windows", () => {
    const attributes = readFileSync(gitAttributesPath, "utf8");
    expect(attributes).toContain("packages/db-schema/scripts/*.mjs text eol=lf");
    expect(attributes).toContain("install/haniel-standalone.yaml.template text eol=lf");
    expect(attributes).toContain(
      "soul-server-ts/tests/fixtures/eiaserinnys-haniel-services.yaml text eol=lf",
    );
  });

  it("pins a Node 20 compatible pnpm instead of resolving the moving Corepack latest", () => {
    const workflowText = readFileSync(workflowPath, "utf8");
    const workflow = parse(workflowText);
    expect(workflow.env.PNPM_VERSION).toBe("10.32.1");
    expect(workflowText.match(/corepack prepare pnpm@\$\{\{ env\.PNPM_VERSION \}\} --activate/g))
      .toHaveLength(3);
    expect(workflowText.match(/node-version: '20'/g)).toHaveLength(3);
  });

  it("parses and triggers for every executor contract surface", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    const expected = [
      "packages/db-schema/**",
      "soul-server-ts/scripts/**",
      "soul-server-ts/tests/scripts/**",
      "orch-server-ts/scripts/**",
      "orch-server-ts/tests/**",
      "deploy/release-manifest*.json",
      "deploy/database-release-*.json",
      ".github/workflows/test-install.yml",
    ];
    for (const event of ["push", "pull_request"]) {
      expect(workflow.on[event].paths).toEqual(expect.arrayContaining(expected));
    }
  });

  it("runs process, CLI, board and Haniel contracts on Linux and Windows", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    const job = workflow.jobs["database-release-contracts"];
    expect(job.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    const commands = job.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    for (const test of [
      "release_executor_concurrency_review.test.ts",
      "release_executor_cli_review.test.ts",
      "release_executor_review.test.ts",
      "migration_contract.test.ts",
    ]) {
      expect(commands).toContain(test);
    }
    expect(commands).toContain("test_haniel_release_contract.py");
    expect(commands).toContain("--maxWorkers=2 --minWorkers=1");
  });

  it("runs canonical inventory against an explicit isolated PostgreSQL service", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    const job = workflow.jobs["database-release-postgres"];
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.services.postgres.image).toMatch(/^postgres:16/);
    expect(job.env.TEST_DATABASE_URL).toContain("release_executor_test_db");
    const commands = job.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(commands).toContain("release_executor_postgres_review.test.ts");
    for (const test of databaseTestFiles) expect(commands).toContain(test);
    expect(commands).toContain("verify-vitest-contract-result.mjs");
    expect(commands).toContain("29");
    expect(commands).toContain("--maxWorkers=2 --minWorkers=1");
  });

  it("runs the real executor PostgreSQL suite without skips on Windows", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    const job = workflow.jobs["test-install"];
    const commands = job.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    for (const test of databaseTestFiles) expect(commands).toContain(test);
    expect(commands).toContain("TEST_DATABASE_URL");
    expect(commands).toContain("--reporter=default --reporter=json");
    expect(commands).toContain("--outputFile.json=$resultPath");
    expect(commands).toContain("verify-vitest-contract-result.mjs");
    expect(commands).toContain("26");
  });

  it("routes all three real PostgreSQL suites through the shared safe harness", () => {
    for (const test of databaseTestFiles) {
      const source = readFileSync(new URL(test, import.meta.url), "utf8");
      expect(source).toContain("database_test_harness");
    }
  });
});
