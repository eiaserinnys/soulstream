import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(
  fileURLToPath(new URL(`../../src/${relative}`, import.meta.url)),
  "utf8",
);

describe("TaskCreationHook production seam", () => {
  it("keeps durable session registration behind the single TaskCreation boundary", () => {
    const directRegistrationOwners = [
      "task/task_creation.ts",
      "db/session_db.ts",
    ].filter((path) => source(path).includes(".registerSession("));
    expect(directRegistrationOwners).toEqual(["task/task_creation.ts", "db/session_db.ts"]);
    expect(source("task/task_manager.ts").match(/new TaskCreation\(/g)).toHaveLength(1);
  });

  it("routes every production create entrypoint through TaskManager.createTask", () => {
    const entrypoints = [
      "mcp/tools/session_mgmt.ts",
      // task_tree_service.ts는 PR-AT에서 v1 태스크 생성이 폐기되어 생성 진입점이 아니다.
      "upstream/task_runtime_commands.ts",
      "supervisor/activation.ts",
      "llm/executor.ts",
      "runtime/supervisor_composition.ts",
    ];
    for (const path of entrypoints) {
      expect(source(path), path).toContain(".createTask(");
      expect(source(path), path).not.toContain("new TaskCreation(");
      expect(source(path), path).not.toContain(".registerSession(");
    }
  });
});
