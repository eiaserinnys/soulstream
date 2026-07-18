import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("Task public contract", () => {
  it("uses the task namespace for MCP, HTTP, wire, container, and DB writes", () => {
    const mcp = read("soul-server-ts/src/mcp/tools/task_object_tools.ts");
    expect(mcp).toContain('"create_task"');
    expect(mcp).toContain('"get_task"');
    expect(mcp).toContain('"list_tasks"');
    expect(mcp).toContain('"list_task_operations"');
    expect(mcp).not.toMatch(/registerTool\([\s\S]{0,120}"(?:create|update|archive|unarchive|set|move)_runbook/);

    const routes = read("orch-server-ts/src/tasks/task_routes.ts");
    expect(routes).toContain('"/api/tasks/my-turn"');
    expect(routes).toContain('"/api/tasks/:task_id"');
    expect(routes).not.toContain('post("/api/runbooks');

    const wire = read("packages/wire-schema/src/upstream.schema.json");
    expect(wire).toContain('"const": "task_updated"');
    expect(wire).toContain('"taskId"');

    const schema = read("packages/db-schema/sql/schema.sql");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS tasks (");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS task_sections (");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS task_items (");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS task_operations (");
    expect(schema).toContain("CHECK (container_kind IN ('folder','task'))");
  });

  it("keeps only the declared one-release read compatibility surface", () => {
    const compat = read("soul-server-ts/src/mcp/tools/task_legacy_read_compat.ts");
    expect(compat.match(/"(?:get_runbook|list_runbooks|list_runbook_operations)"/g)?.sort()).toEqual([
      '"get_runbook"',
      '"list_runbook_operations"',
      '"list_runbooks"',
    ]);
    expect(compat).not.toMatch(/"(?:create|update|archive|unarchive|set|move)_runbook/);

    const migration = read("packages/db-schema/sql/migrations/042_runbook_to_task.sql");
    expect(migration).toContain("041_retire_task_tree.sql must run before 042_runbook_to_task.sql");
    expect(migration).toContain("CREATE OR REPLACE VIEW runbooks");
    expect(migration).toContain("CREATE OR REPLACE VIEW runbook_sections");
    expect(migration).toContain("CREATE OR REPLACE VIEW runbook_items");
    expect(migration).toContain("CREATE OR REPLACE VIEW runbook_operations");
  });
});
