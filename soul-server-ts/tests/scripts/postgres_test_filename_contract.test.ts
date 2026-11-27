import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isPostgresTestFile } from "../../../packages/db-schema/scripts/postgres-test-policy.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const harness = /(?:postgres-test-container|isolated_postgres_harness|full_schema_postgres_harness|postgres_test_harness|database_test_harness|board_yjs_postgres_harness|page_postgres_harness|report-timeline-postgres-database|board-roundtrip-harness)/;
const exemptions: Record<string, string> = {
  "soul-server-ts/tests/scripts/postgres_test_container.test.ts": "Mocks Docker to test the container helper without opening a database.",
  "soul-server-ts/tests/scripts/release_executor_ci_contract.test.ts": "Reads workflow and source text without opening a database.",
  "soul-server-ts/tests/scripts/postgres_test_filename_contract.test.ts": "Checks a synthetic import string without opening a database.",
};

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function violations(entries: Array<{ path: string; source: string }>): string[] {
  return entries.filter(({ path, source }) => {
    const imports = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)];
    return imports.some(([, target]) => harness.test(target!)) && !exemptions[path] && !isPostgresTestFile(path);
  }).map(({ path }) => path).sort();
}

function containerWithoutExternalDatabase(entries: Array<{ path: string; source: string }>): string[] {
  return entries.filter(({ path, source }) => {
    const startsContainer = [...source.matchAll(/\bfrom\s*["']([^"']+)["']/g)]
      .some(([, target]) => /postgres-test-container/.test(target!));
    return startsContainer && !source.includes("TEST_DATABASE_URL")
      && !exemptions[path] && !path.endsWith(".docker.postgres.test.ts");
  }).map(({ path }) => path).sort();
}

describe("PostgreSQL test filename contract", () => {
  it("detects an incorrectly named test that imports a harness", () => {
    expect(violations([{ path: "tests/missing.test.ts", source: 'import { x } from "./page_postgres_harness.js";' }])).toEqual(["tests/missing.test.ts"]);
  });

  it("names direct harness users for the PostgreSQL test policy", () => {
    const entries = ["soul-server-ts/tests", "orch-server-ts/tests"].flatMap((dir) => files(resolve(root, dir)))
      .map((file) => ({ path: relative(root, file).replaceAll("\\", "/"), source: readFileSync(file, "utf8") }));
    expect(violations(entries)).toEqual([]);
  });

  it("has no test that starts a container without reading TEST_DATABASE_URL", () => {
    const synthetic = 'import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";';
    expect(containerWithoutExternalDatabase([{ path: "tests/a.postgres.test.ts", source: synthetic }])).toEqual(["tests/a.postgres.test.ts"]);
    expect(containerWithoutExternalDatabase([{ path: "tests/a.docker.postgres.test.ts", source: synthetic }])).toEqual([]);
    const entries = ["soul-server-ts/tests", "orch-server-ts/tests"].flatMap((dir) => files(resolve(root, dir)))
      .map((file) => ({ path: relative(root, file).replaceAll("\\", "/"), source: readFileSync(file, "utf8") }));
    expect(containerWithoutExternalDatabase(entries)).toEqual([]);
  });
});
