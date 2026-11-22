import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { AgentRegistry, readAgentsConfig } from "../src/agent_registry.js";
import { AgentConfigService } from "../src/agent_config_service.js";
import { McpConfigService } from "../src/mcp_config_service.js";

import { makeTempDirSync } from "./helpers/temp_dir.js";

describe("AgentConfigService", () => {
  let tempDir: string;
  let configPath: string;
  let snapshotRoot: string;
  let registry: AgentRegistry;
  let service: AgentConfigService;

  beforeEach(() => {
    tempDir = makeTempDirSync("agent-config-service-");
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

  it("plans and applies shallow patches without deleting omitted fields", async () => {
    fs.appendFileSync(configPath, [
      "    default_preset: codex-preset",
      "    disallowed_tools: [shell]",
      "    claude_permission_mode: plan",
      "    env: { OLD: old, KEEP: keep }",
      "",
    ].join("\n"));
    fs.writeFileSync(configPath, stringifyYaml(readAgentsConfig(configPath)));
    const patch = { id: "codex-default", name: "Updated" };
    const expected = {
      id: "codex-default", name: "Updated", backend: "codex", workspace_dir: "/tmp/codex",
      default_preset: "codex-preset", disallowed_tools: ["shell"],
      claude_permission_mode: "plan", env: { OLD: "old", KEEP: "keep" },
    };
    const plan = await service.planProfileUpdate(patch, false, { includeTextDiff: true });
    expect(plan.config.agents[0]).toEqual(expected);
    expect(plan.semanticChanges[0]).toMatchObject({ op: "replace_agent", after: expected });
    expect(plan.diff).not.toContain("-    default_preset");
    const applied = await service.replaceProfile(patch, false, { includeTextDiff: true });
    expect(applied.config.agents[0]).toEqual(expected);
    expect(applied.semanticChanges).toEqual(plan.semanticChanges);
    expect(applied.diff).toEqual(plan.diff);
    expect(readAgentsConfig(configPath).agents[0]).toEqual(expected);
    const replaced = await service.replaceProfile({ id: "codex-default", env: { NEW: "new" } });
    expect(replaced.config.agents[0]?.env).toEqual({ NEW: "new" });
  });

  it("deletes null fields and validates merged and newly created profiles", async () => {
    fs.appendFileSync(configPath, "    model: old-model\n");
    const patch = { id: "codex-default", model: null };
    const plan = await service.planProfileUpdate(patch);
    expect(plan.config.agents[0]).not.toHaveProperty("model");
    const applied = await service.replaceProfile(patch);
    expect(applied.config.agents[0]).not.toHaveProperty("model");
    for (const run of [service.planProfileUpdate.bind(service), service.replaceProfile.bind(service)]) {
      await expect(run({ id: "codex-default", name: null })).rejects.toThrow();
      await expect(run({ id: "new-agent" }, true)).rejects.toThrow();
    }
    const created = await service.replaceProfile({
      id: "new-agent", name: "New", backend: "codex", workspace_dir: "/tmp/new", model: null,
    }, true);
    expect(created.config.agents[1]).not.toHaveProperty("model");
  });

  it("replaces one profile through ConfigStore and reloads the runtime registry", async () => {
    const result = await service.replaceProfile({
      id: "codex-default",
      name: "Codex Updated",
      backend: "codex",
      workspace_dir: "/tmp/codex",
      max_turns: 25,
      model: "gpt-5.3-codex-spark",
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
    expect(registry.get("codex-default")?.model).toBe("gpt-5.3-codex-spark");
  });

  it("round-trips context_scope through plan, apply, and read", async () => {
    const profile = {
      id: "codex-default",
      name: "Codex",
      backend: "codex",
      workspace_dir: "/tmp/codex",
      context_scope: "minimal",
    } as const;

    const plan = await service.planProfileUpdate(profile);
    expect(plan.changed).toBe(true);
    expect(plan.semanticChanges).toEqual([
      expect.objectContaining({
        op: "replace_agent",
        after: expect.objectContaining({ context_scope: "minimal" }),
      }),
    ]);

    const result = await service.replaceProfile(profile);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(configPath, "utf-8")).toContain("context_scope: minimal");
    expect(readAgentsConfig(configPath).agents[0]?.context_scope).toBe("minimal");
    expect(registry.get("codex-default")?.context_scope).toBe("minimal");
  });

  it("rejects YAML identity edits for profiles owned by a DB overlay", async () => {
    service = new AgentConfigService({
      configPath,
      snapshotRoot,
      agentRegistry: registry,
      isDbIdentityOwnedProfile: (profileId) => profileId === "codex-default",
    });

    await expect(service.replaceProfile({
      id: "codex-default",
      name: "Changed in YAML",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    })).rejects.toThrow(
      "identity fields are owned by the central profile: name. Use update_central_agent_profile to change them.",
    );

    expect(fs.readFileSync(configPath, "utf-8")).toContain("name: Codex");
  });

  it("allows deleting YAML identity fields when a central profile owns the profile", async () => {
    fs.writeFileSync(
      configPath,
      [
        "agents:",
        "  - id: codex-default",
        "    name: Codex",
        "    backend: codex",
        "    workspace_dir: /tmp/codex",
        "    default_preset: claude-opus",
        "    aliases:",
        "      - codex-opus",
        "    atom_contexts:",
        "      - node_id: 11111111-1111-4111-8111-111111111111",
        "",
      ].join("\n"),
      "utf-8",
    );
    service = new AgentConfigService({
      configPath,
      snapshotRoot,
      agentRegistry: registry,
      isDbIdentityOwnedProfile: (profileId) => profileId === "codex-default",
    });

    const result = await service.replaceProfile({
      id: "codex-default",
      name: "Codex",
      backend: "codex",
      workspace_dir: "/tmp/codex",
      default_preset: null,
      aliases: null,
      atom_contexts: null,
    });

    expect(result.changed).toBe(true);
    const written = fs.readFileSync(configPath, "utf-8");
    expect(written).not.toContain("default_preset");
    expect(written).not.toContain("aliases");
    expect(written).not.toContain("atom_contexts");
  });

  it("notifies after registry reload when a profile apply changes config", async () => {
    const onAfterRegistryReplace = vi.fn(() => {
      expect(registry.get("codex-default")?.name).toBe("Codex Callback");
    });
    service = new AgentConfigService({
      configPath,
      snapshotRoot,
      agentRegistry: registry,
      onAfterRegistryReplace,
    });

    await service.replaceProfile({
      id: "codex-default",
      name: "Codex Callback",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    });

    expect(onAfterRegistryReplace).toHaveBeenCalledTimes(1);
  });

  it("does not notify when a profile apply is a no-op", async () => {
    const onAfterRegistryReplace = vi.fn();
    service = new AgentConfigService({
      configPath,
      snapshotRoot,
      agentRegistry: registry,
      onAfterRegistryReplace,
    });

    await service.replaceProfile({
      id: "codex-default",
      name: "Codex",
      backend: "codex",
      workspace_dir: "/tmp/codex",
    });

    expect(onAfterRegistryReplace).not.toHaveBeenCalled();
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

  it("keeps claude_auto_memory_enabled through plan, apply, and read", async () => {
    const profile = {
      id: "claude-no-memory",
      name: "Claude No Memory",
      backend: "claude",
      workspace_dir: "/tmp/claude-no-memory",
      claude_auto_memory_enabled: false,
    } as const;

    const plan = await service.planProfileUpdate(profile, true);
    expect(plan.semanticChanges).toEqual([
      expect.objectContaining({
        op: "add_agent",
        agentId: "claude-no-memory",
        after: expect.objectContaining({ claude_auto_memory_enabled: false }),
      }),
    ]);

    await service.replaceProfile(profile, true);

    expect(registry.get("claude-no-memory")?.claude_auto_memory_enabled).toBe(false);
    const { raw, parsed } = service.readRaw();
    expect(raw).toContain("claude_auto_memory_enabled: false");
    expect(
      parsed.agents.find((agent) => agent.id === "claude-no-memory")?.claude_auto_memory_enabled,
    ).toBe(false);
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
    const defaultIdsNodeId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const applied = await service.setAgentAtomContexts("codex-default", [
      { node_id: nodeId, depth: 2, titles_only: true, include_ids: false },
      { node_id: defaultIdsNodeId, depth: 3, titles_only: false },
    ]);

    expect(registry.get("codex-default")?.atom_contexts).toEqual([
      { node_id: nodeId, depth: 2, titles_only: true, include_ids: false },
      { node_id: defaultIdsNodeId, depth: 3, titles_only: false },
    ]);
    const saved = fs.readFileSync(configPath, "utf-8");
    expect(saved).toContain("include_ids: false");
    expect(saved.match(/include_ids:/g)).toHaveLength(1);

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
