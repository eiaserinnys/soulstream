import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { composeSupervisorRuntime } from "../../src/runtime/supervisor_composition.js";
import { composeWorkerRuntime } from "../../src/runtime/worker_composition.js";
import { composeChecklistRunbookProjection } from "../../src/runtime/checklist_runbook_composition.js";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

function source(relativePath: string): string {
  return readFileSync(`${sourceRoot}${relativePath}`, "utf8");
}

describe("worker composition boundary", () => {
  it("exports explicit worker and supervisor composition roots", () => {
    expect(composeWorkerRuntime).toBeTypeOf("function");
    expect(composeSupervisorRuntime).toBeTypeOf("function");
  });

  it("keeps process lifecycle in main and dependency construction in composition modules", () => {
    const main = source("main.ts");
    const workerComposition = source("runtime/worker_composition.ts");
    const supervisorComposition = source("runtime/supervisor_composition.ts");

    expect(main).toContain("composeWorkerRuntime");
    expect(main).toContain('process.once("SIGTERM"');
    expect(main).not.toMatch(/new (SessionDB|TaskManager|TaskExecutor|RunbookService)\b/);
    expect(workerComposition).toMatch(/new (SessionDB|TaskManager|RunbookService)\b/);
    expect(supervisorComposition).toContain("new TaskExecutor");
  });

  it("wires durable page ancestry through the existing orch host client", () => {
    const workerComposition = source("runtime/worker_composition.ts");

    expect(workerComposition).toContain("new HostPageContextRepository");
    expect(workerComposition).toContain("new AncestorPageContextResolver");
    expect(workerComposition).toContain("new DefaultPageContextAssembler");
    expect(workerComposition).not.toContain("NO_PAGE_ANCHOR_CONTEXT_RESOLVER");
  });

  it("exports an executable checklist projection composition boundary", () => {
    expect(composeChecklistRunbookProjection).toBeTypeOf("function");
  });

  it("keeps every production module touched by the extraction below 500 lines", () => {
    const files = [
      "main.ts",
      "runtime/worker_composition.ts",
      "runtime/supervisor_composition.ts",
      "context/context_builder.ts",
      "context/context_builder_helpers.ts",
      "context/page_context_resolver.ts",
      "context/page_context_repository.ts",
      "context/page_context_assembler.ts",
      "page/checklist_runbook_adapter.ts",
      "page/checklist_runbook_projection_repository.ts",
      "page/checklist_runbook_reconciler.ts",
      "runtime/checklist_runbook_composition.ts",
      "runbook/runbook_service.ts",
      "task/task_creation.ts",
      "task/task_creation_hook.ts",
    ];

    for (const file of files) {
      const lineCount = source(file).split("\n").length;
      expect(lineCount, file).toBeLessThanOrEqual(500);
    }
  });
});
