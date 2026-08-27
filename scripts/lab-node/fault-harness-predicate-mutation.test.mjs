import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const runtime = readFileSync(join(directory, "fault-harness-runtime.mjs"), "utf8");
const schema = readFileSync(
  join(directory, "..", "..", "packages", "db-schema", "sql", "schema.sql"),
  "utf8",
);

test("predicate-misplaced mutation never fires on the real acquire or release transition", () => {
  const predicate = runtime.match(
    /const predicate = mutation === "predicate_misplaced"\s*\? `([\s\S]*?)`\s*: `/,
  )?.[1];
  assert.ok(predicate, "predicate_misplaced SQL predicate is missing");

  assert.match(predicate, /OLD\.execution_manifest_id IS NULL/);
  assert.match(predicate, /NEW\.execution_manifest_id IS NOT NULL/);
  assert.match(
    predicate,
    /NEW\.execution_generation = OLD\.execution_generation \+ 2/,
  );
  assert.doesNotMatch(predicate, /OLD\.execution_manifest_id IS NOT NULL/);
  assert.doesNotMatch(predicate, /NEW\.execution_manifest_id IS NULL/);

  assert.match(
    schema,
    /execution_generation = session\.execution_generation \+ 1/,
    "the real acquire transition must remain generation +1",
  );
  assert.match(runtime, /IF \$\{predicate\} THEN\s*PERFORM nextval/);
  assert.match(runtime, /PERFORM pg_sleep\(\$\{delaySeconds\}\)/);
  assert.match(runtime, /RAISE EXCEPTION 'lab injected sessions-row execution acquire failure'/);
});
