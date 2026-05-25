import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRegistry } from "../src/agent_registry.js";
import { AgentConfigService } from "../src/agent_config_service.js";
import { McpConfigService } from "../src/mcp_config_service.js";

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
    expect(result.configChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.baseConfigChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.semanticChanges).toEqual([
      expect.objectContaining({
        op: "replace_agent",
        agentId: "codex-default",
      }),
    ]);
    expect(result.textDiffIncluded).toBe(true);
    expect(result.reloadOk).toBe(true);
    expect(result.diff).toContain("-    name: Codex");
    expect(result.diff).toContain("+    name: Codex Updated");
    expect(registry.get("codex-default")?.name).toBe("Codex Updated");
    expect(registry.get("codex-default")?.max_turns).toBe(25);
  });

  it("plans an add profile as a semantic change without default text diff", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const profile = {
      id: "smoke-config-plan-do-not-create",
      name: "Smoke Plan",
      backend: "codex",
      workspace_dir: "/tmp/smoke-plan",
    } as const;

    const plan = await service.planProfileUpdate(profile, true);

    expect(plan.changed).toBe(true);
    expect(plan.configChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.baseConfigChecksum).toBe(plan.configChecksum);
    expect(plan.textDiffIncluded).toBe(false);
    expect(plan.diff).toBe("");
    expect(plan.semanticChanges).toEqual([
      {
        op: "add_agent",
        agentId: "smoke-config-plan-do-not-create",
        before: null,
        after: profile,
      },
    ]);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("plans a no-op profile update as changed=false with no_change semantics", async () => {
    const plan = await service.planProfileUpdate({
      workspace_dir: "/tmp/codex",
      backend: "codex",
      name: "Codex",
      id: "codex-default",
    });

    expect(plan.changed).toBe(false);
    expect(plan.textDiffIncluded).toBe(false);
    expect(plan.diff).toBe("");
    expect(plan.semanticChanges).toEqual([
      {
        op: "no_change",
        agentId: "codex-default",
        before: {
          id: "codex-default",
          name: "Codex",
          backend: "codex",
          workspace_dir: "/tmp/codex",
        },
        after: {
          id: "codex-default",
          name: "Codex",
          backend: "codex",
          workspace_dir: "/tmp/codex",
        },
      },
    ]);
  });

  it("includes text diff only when explicitly requested", async () => {
    const plan = await service.planProfileUpdate(
      {
        id: "codex-default",
        name: "Codex Planned",
        backend: "codex",
        workspace_dir: "/tmp/codex-ws",
      },
      false,
      { includeTextDiff: true },
    );

    expect(plan.changed).toBe(true);
    expect(plan.textDiffIncluded).toBe(true);
    expect(plan.diff).toContain("--- agents.yaml");
    expect(plan.diff).toContain("Codex Planned");
    expect(plan.semanticChanges[0]).toMatchObject({
      op: "replace_agent",
      agentId: "codex-default",
    });
  });

  it("applies profile changes with semantic result and opt-in text diff", async () => {
    const updated = await service.replaceProfile(
      {
        id: "codex-default",
        name: "Codex Applied",
        backend: "codex",
        workspace_dir: "/tmp/codex-ws",
      },
      false,
      { includeTextDiff: false },
    );

    expect(updated.changed).toBe(true);
    expect(updated.textDiffIncluded).toBe(false);
    expect(updated.diff).toBe("");
    expect(updated.snapshotPath).toBeTruthy();
    expect(updated.semanticChanges).toEqual([
      expect.objectContaining({
        op: "replace_agent",
        agentId: "codex-default",
      }),
    ]);
    expect(registry.get("codex-default")?.name).toBe("Codex Applied");
  });

  it("rejects profile apply when the expected config checksum is stale", async () => {
    const profile = {
      id: "codex-default",
      name: "Codex Applied",
      backend: "codex",
      workspace_dir: "/tmp/codex-ws",
    } as const;
    const plan = await service.planProfileUpdate(profile);
    fs.writeFileSync(
      configPath,
      [
        "agents:",
        "  - id: codex-default",
        "    name: Concurrent Edit",
        "    backend: codex",
        "    workspace_dir: /tmp/codex",
        "",
      ].join("\n"),
      "utf-8",
    );

    await expect(
      service.replaceProfile(profile, false, {
        expectedConfigChecksum: plan.configChecksum,
      }),
    ).rejects.toThrow(/config checksum mismatch/);
    expect(registry.get("codex-default")?.name).toBe("Codex");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("Concurrent Edit");
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
      snapshotId: path.basename(applied.snapshotPath ?? ""),
      snapshotPath: applied.snapshotPath,
      configPath,
      configName: "agents.yaml",
      sizeBytes: expect.any(Number),
    });
  });

  it("rolls back by managed snapshot id", async () => {
    const applied = await service.replaceProfile({
      id: "codex-default",
      name: "Codex Updated",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    });
    expect(registry.get("codex-default")?.name).toBe("Codex Updated");

    await service.rollback(path.basename(applied.snapshotPath ?? ""), {
      includeTextDiff: false,
    });

    expect(registry.get("codex-default")?.name).toBe("Codex");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("name: Codex");
  });

  it("plans and applies a narrow mcp_profile reference update", async () => {
    fs.writeFileSync(
      path.join(tempDir, "mcp-profiles.yaml"),
      ["profiles:", "  - id: research", ""].join("\n"),
      "utf-8",
    );
    const mcpConfig = new McpConfigService({ agentsConfigPath: configPath });
    service = new AgentConfigService({
      configPath,
      snapshotRoot,
      agentRegistry: registry,
      profileResolver: (profiles) => mcpConfig.resolveProfiles(profiles),
    });

    const plan = await service.planSetAgentMcpProfile("codex-default", "research");

    expect(plan.changed).toBe(true);
    expect(plan.semanticChanges).toEqual([
      {
        op: "update_agent_mcp_profile",
        agentId: "codex-default",
        before: null,
        after: "research",
      },
    ]);
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("mcp_profile:");

    const updated = await service.setAgentMcpProfile("codex-default", "research", {
      includeTextDiff: false,
    });

    expect(updated.changed).toBe(true);
    expect(updated.textDiffIncluded).toBe(false);
    expect(updated.semanticChanges).toEqual([
      expect.objectContaining({
        op: "update_agent_mcp_profile",
        agentId: "codex-default",
      }),
    ]);
    expect(registry.get("codex-default")?.mcp_profile).toBe("research");
    expect(fs.readFileSync(configPath, "utf-8")).toContain("mcp_profile: research");
  });

  it("rejects invalid mcp_profile references before writing agents.yaml", async () => {
    const before = fs.readFileSync(configPath, "utf-8");
    const mcpConfig = new McpConfigService({ agentsConfigPath: configPath });
    service = new AgentConfigService({
      configPath,
      snapshotRoot,
      agentRegistry: registry,
      profileResolver: (profiles) => mcpConfig.resolveProfiles(profiles),
    });

    await expect(
      service.setAgentMcpProfile("codex-default", "missing-profile"),
    ).rejects.toThrow(/MCP profile not found: missing-profile/);

    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(registry.get("codex-default")?.mcp_profile).toBeUndefined();
  });
});
