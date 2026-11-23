import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = fileURLToPath(new URL(
  "../../../.github/workflows/test-install.yml",
  import.meta.url,
));
const workflowsDirectory = fileURLToPath(new URL(
  "../../../.github/workflows/",
  import.meta.url,
));
const soulServerPackagePath = fileURLToPath(new URL(
  "../../package.json",
  import.meta.url,
));
const soulServerTsupPath = fileURLToPath(new URL(
  "../../tsup.config.ts",
  import.meta.url,
));
const orchServerPackagePath = fileURLToPath(new URL(
  "../../../orch-server-ts/package.json",
  import.meta.url,
));
const orchServerTsupPath = fileURLToPath(new URL(
  "../../../orch-server-ts/tsup.config.ts",
  import.meta.url,
));
const pageModelPackagePath = fileURLToPath(new URL(
  "../../../packages/page-model/package.json",
  import.meta.url,
));
const gitAttributesPath = fileURLToPath(new URL(
  "../../../.gitattributes",
  import.meta.url,
));
const databaseTestFiles = [
  "release_executor.postgres.test.ts",
  "migration_runner.postgres.test.ts",
  "apply_schema.postgres.test.ts",
];

describe("database release CI contract", () => {
  it("keeps executable database release modules LF-normalized on Windows", () => {
    const attributes = readFileSync(gitAttributesPath, "utf8");
    expect(attributes).toContain("packages/db-schema/scripts/*.mjs text eol=lf");
    expect(attributes).toContain("install/haniel-worker.yaml.template text eol=lf");
    expect(attributes).toContain(
      "soul-server-ts/tests/fixtures/eiaserinnys-haniel-services.yaml text eol=lf",
    );
  });

  it("pins the Node 22 baseline and a fixed pnpm instead of moving Corepack latest", () => {
    const workflowText = readFileSync(workflowPath, "utf8");
    const workflow = parse(workflowText);
    expect(workflow.env.PNPM_VERSION).toBe("10.32.1");
    expect(workflowText.match(/corepack prepare pnpm@\$\{\{ env\.PNPM_VERSION \}\} --activate/g))
      .toHaveLength(3);
    expect(workflowText.match(/node-version: '22'/g)).toHaveLength(4);
    const allWorkflowSources = readdirSync(workflowsDirectory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .map((name) => readFileSync(`${workflowsDirectory}/${name}`, "utf8"))
      .join("\n");
    expect(allWorkflowSources).not.toContain("node-version: '20'");
  });

  it("aligns server build targets, Node types, and runtime floor on Node 22", () => {
    const soulServerPackage = JSON.parse(readFileSync(soulServerPackagePath, "utf8"));
    const orchServerPackage = JSON.parse(readFileSync(orchServerPackagePath, "utf8"));
    const pageModelPackage = JSON.parse(readFileSync(pageModelPackagePath, "utf8"));

    expect(soulServerPackage.engines).toEqual({ node: ">=22.5" });
    expect(soulServerPackage.scripts.build).toContain("--target node22");
    expect(soulServerPackage.devDependencies["@types/node"]).toMatch(/^\^22\./);
    expect(orchServerPackage.devDependencies["@types/node"]).toMatch(/^\^22\./);
    expect(pageModelPackage.devDependencies["@types/node"]).toMatch(/^\^22\./);
    expect(readFileSync(soulServerTsupPath, "utf8")).toContain('target: "node22"');
    expect(readFileSync(orchServerTsupPath, "utf8")).toContain('target: "node22"');
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
      "release_executor_installer.test.ts",
      "release_executor_concurrency_review.test.ts",
      "release_executor_cli_review.test.ts",
      "release_executor_review.test.ts",
      "migration_contract.test.ts",
    ]) {
      expect(commands).toContain(test);
    }
    expect(commands).toContain('-p "test_*.py"');
    expect(commands).toContain("--maxWorkers=2 --minWorkers=1");
  });

  it("runs migration release contracts against an isolated PostgreSQL service", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    const job = workflow.jobs["database-release-postgres"];
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.services.postgres.image).toMatch(/^postgres:16/);
    expect(job.env.TEST_DATABASE_URL).toContain("release_executor_test_db");
    const commands = job.steps.map((step: { run?: string }) => step.run ?? "").join("\n");
    expect(commands).toContain("release_executor_postgres_review.postgres.test.ts");
    expect(commands).toContain("tests/scripts/migration_runner.postgres.test.ts");
    for (const test of databaseTestFiles) expect(commands).toContain(test);
    expect(commands).toContain("verify-vitest-contract-result.mjs");
    expect(commands).toContain(
      "soul-server-ts/database-release-postgres-results.json 30",
    );
    expect(commands).toContain("--maxWorkers=2 --minWorkers=1");
    expect(commands).toContain("--reporter=default --reporter=json");
    expect(commands).toContain(
      "--outputFile.json=database-release-postgres-results.json",
    );
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
    expect(commands).toContain("25");
  });

  it("installs the checked-out commit from a pinned local repository", () => {
    const workflow = parse(readFileSync(workflowPath, "utf8"));
    const job = workflow.jobs["test-install"];
    const checkout = job.steps.find((step: { name: string }) => step.name === "Checkout");
    const pinIndex = job.steps.findIndex((step: { name: string }) => step.name === "Pin installer source");
    const installIndex = job.steps.findIndex((step: { name: string }) => step.name === "Run installer and verify release activation");
    const verifyIndex = job.steps.findIndex((step: { name: string }) => step.name === "Verify installed source commit");
    expect(checkout.with["fetch-depth"]).toBe(0);
    expect(pinIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(pinIndex);
    expect(verifyIndex).toBeGreaterThan(installIndex);

    const pin = job.steps[pinIndex].run;
    expect(pin).toContain('git rev-parse HEAD');
    expect(pin).toContain('Join-Path $env:RUNNER_TEMP');
    expect(pin).toContain('git init --bare');
    expect(pin).toContain('git push $repository "${commit}:refs/heads/ci-pinned"');
    expect(pin).toContain(".Replace('\\', '/')");
    expect(pin).toContain('SOULSTREAM_SOURCE_URL=$repository');
    expect(pin).toContain('SOULSTREAM_SOURCE_BRANCH=ci-pinned');
    expect(pin).toContain('SOULSTREAM_PINNED_COMMIT=$commit');
    expect(job.env.SOULSTREAM_SOURCE_URL).toBeUndefined();
    expect(job.env.SOULSTREAM_SOURCE_BRANCH).toBeUndefined();

    const install = job.steps[installIndex].run;
    expect(install).toContain('-RepositoryUrl $env:SOULSTREAM_SOURCE_URL');
    expect(install).toContain('-RepositoryBranch $env:SOULSTREAM_SOURCE_BRANCH');
    const verify = job.steps[verifyIndex].run;
    expect(verify).toContain('git -C "C:\\soulstream-test\\soulstream" rev-parse HEAD');
    expect(verify).toContain('$env:SOULSTREAM_PINNED_COMMIT');
    expect(verify).toContain('$installedCommit -ne $env:SOULSTREAM_PINNED_COMMIT');
    expect(verify).toContain('throw "Installed source commit does not match pinned commit"');
    expect(verify).toContain('startup.*update|update.*startup');
  });

  it("routes all three real PostgreSQL suites through the shared safe harness", () => {
    for (const test of databaseTestFiles) {
      const source = readFileSync(new URL(test, import.meta.url), "utf8");
      expect(source).toContain("database_test_harness");
    }
  });
});
