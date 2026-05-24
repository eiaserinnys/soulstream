import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRegistry } from "../src/agent_registry.js";
import { AgentConfigService } from "../src/agent_config_service.js";

describe("AgentConfigService", () => {
  let tempDir: string;
  let configPath: string;
  let snapshotRoot: string;
  let registry: AgentRegistry;
  let service: AgentConfigService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-service-"));
    configPath = path.join(tempDir, "agents.yaml");
    snapshotRoot = path.join(tempDir, ".local", "config-snapshots");
    fs.writeFileSync(
      configPath,
      [
        "agents:",
        "  - id: codex-default",
        "    name: Codex",
        "    backend: codex",
        "    workspace_dir: /tmp/codex",
        "",
      ].join("\n"),
      "utf-8",
    );
    registry = new AgentRegistry([
      {
        id: "codex-default",
        name: "Codex",
        backend: "codex",
        workspace_dir: "/tmp/codex",
      },
    ]);
    service = new AgentConfigService({
      configPath,
      snapshotRoot,
      agentRegistry: registry,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("replaces one profile through ConfigStore and reloads the runtime registry", async () => {
    const result = await service.replaceProfile({
      id: "codex-default",
      name: "Codex Updated",
      backend: "codex",
      workspace_dir: "/tmp/codex",
      max_turns: 25,
    });

    expect(result.changed).toBe(true);
    expect(result.snapshotPath).toBeTruthy();
    expect(result.diff).toContain("-    name: Codex");
    expect(result.diff).toContain("+    name: Codex Updated");
    expect(registry.get("codex-default")?.name).toBe("Codex Updated");
    expect(registry.get("codex-default")?.max_turns).toBe(25);
  });

  it("sets atom_contexts and can roll back the applied config", async () => {
    const nodeId = "11111111-2222-3333-4444-555555555555";
    const applied = await service.setAgentAtomContexts("codex-default", [
      { node_id: nodeId, depth: 2, titles_only: true },
    ]);

    expect(registry.get("codex-default")?.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true },
    ]);

    await service.rollback(applied.snapshotPath ?? "");

    expect(registry.get("codex-default")?.atom_contexts).toBeUndefined();
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("atom_contexts:");
  });

  it("exposes agents.yaml snapshot inventory", async () => {
    const applied = await service.replaceProfile({
      id: "codex-default",
      name: "Codex Updated",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    });

    const snapshots = service.listSnapshots();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      snapshotPath: applied.snapshotPath,
      configPath,
      configName: "agents.yaml",
      sizeBytes: expect.any(Number),
    });
  });
});
