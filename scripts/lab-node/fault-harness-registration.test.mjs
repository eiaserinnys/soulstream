import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const runtime = readFileSync(join(directory, "fault-harness-runtime.mjs"), "utf8");
const evidence = readFileSync(join(directory, "fault-harness-evidence.mjs"), "utf8");
const schema = readFileSync(
  join(directory, "..", "..", "packages", "db-schema", "sql", "schema.sql"),
  "utf8",
);

test("lab invariant follows the registration pair after ownership projection removal", () => {
  assert.match(evidence, /'unregisteredRunning'/);
  assert.match(evidence, /session\.execution_registration_id IS NULL/);
  assert.match(evidence, /session\.execution_command_id IS NULL/);
  assert.match(runtime, /'openRegistrations'/);

  assert.match(schema, /execution_registration_id TEXT/);
  assert.match(schema, /execution_command_id TEXT/);
  assert.doesNotMatch(schema, /execution_generation BIGINT/);
  assert.doesNotMatch(schema, /execution_manifest_id TEXT/);
  assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS session_execution_ownerships/);
});
