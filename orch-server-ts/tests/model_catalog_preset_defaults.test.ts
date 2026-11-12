import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelCatalogFileStore } from "@soulstream/model-catalog/file-loader";

import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import { ModelPresetAvailabilityService } from "../src/model/model_preset_availability.js";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import {
  createTempModelCatalog,
  repositoryModelCatalog,
  type TempModelCatalog,
} from "./helpers/model_catalog.js";

describe("model catalogue preset validation", () => {
  it("validates a china preset from the full catalogue for a node that never connected", () => {
    const service = new ModelPresetAvailabilityService(
      {
        getConnectedNode: () => undefined,
        getNodeState: () => undefined,
      },
      {
        getSummary: () => ({ generatedAt: "", collectedAt: null, nodes: [] }),
        getLimitRejection: () => null,
        getClaudePoolAccountsForAvailability: (_nodeId, accounts) => accounts,
      },
      repositoryModelCatalog(),
    );

    expect(service.resolveStaticForNode("node-never-seen", "kimi-2", { requireAvailable: false }))
      .toMatchObject({
        id: "kimi-2",
        label: "Kimi - 2",
        backend: "claude",
        model: "kimi-for-coding",
        available: false,
        usage_provider: "claude",
      });
    expect(() => service.resolveStaticForNode("node-never-seen", "kimi-2", { requireAvailable: true }))
      .toThrow("not advertised by node node-never-seen");
  });
});

describe("persistent session catalogue defaults", () => {
  let catalog: TempModelCatalog | undefined;

  afterEach(() => {
    catalog?.cleanup();
    catalog = undefined;
  });

  it("reads the new-session default preset and legacy fallback list from the catalogue", async () => {
    catalog = createTempModelCatalog((text) => text
      .replace("model_preset: claude-opus\n", "model_preset: claude-sonnet\n")
      .replace(
        "    - model_preset: codex-6.1-sol\n      reasoning_effort: high\n",
        "    - model_preset: codex-6-sol\n      reasoning_effort: xhigh\n",
      ));
    const { service, resolveStaticForNode } = settingsService(catalog.store, {
      default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
    });

    const defaults = await service.createDefaults();
    expect(resolveStaticForNode).toHaveBeenCalledWith("eiaserinnys", "claude-sonnet");
    expect(defaults.settings.default_model).toEqual({
      model_preset: "claude-sonnet",
      reasoning_effort: "high",
    });
    expect(defaults.settings.fallback_models).toEqual([
      { model_preset: "codex-6-sol", reasoning_effort: "xhigh" },
    ]);
    expect(defaults.settings.fallback_model).toEqual({
      model_preset: "codex-6-sol",
      reasoning_effort: "xhigh",
    });

    const listed = await service.list(SERVICE_CALLER);
    expect(listed.sessions[0]?.settings.fallback_models).toEqual([
      { model_preset: "codex-6-sol", reasoning_effort: "xhigh" },
    ]);
  });

  it("keeps an explicitly stored fallback list instead of the catalogue default", async () => {
    catalog = createTempModelCatalog();
    const { service } = settingsService(catalog.store, {
      default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
      fallback_models: [{ model_preset: "claude-haiku", reasoning_effort: null }],
    });

    const listed = await service.list(SERVICE_CALLER);
    expect(listed.sessions[0]?.settings.fallback_models).toEqual([
      { model_preset: "claude-haiku", reasoning_effort: null },
    ]);
  });
});

function settingsService(
  modelCatalog: ModelCatalogFileStore,
  storedSettings: Record<string, unknown>,
) {
  const row = {
    session_id: "pas-catalogue-defaults",
    session_type: "claude",
    node_id: "node-1",
    agent_id: "agent-1",
    display_name: "Persistent session",
    folder_id: null,
    model_preset: "claude-opus",
    model: "opus",
    reasoning_effort: "high",
    metadata: [{ type: "persistent_settings", value: storedSettings }],
  };
  const resolveStaticForNode = vi.fn((_nodeId: string, presetId: string) => ({
    id: presetId,
    label: presetId,
    backend: "claude" as const,
    model: presetId,
    available: true,
    usage_provider: "claude" as const,
    default_effort: "high" as const,
  }));
  const service = new PersistentSessionSettingsService({
    reads: async () => ({
      getSession: async () => row as never,
      listPersistentSessions: async () => [row] as never,
    }),
    access: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) as never,
      requireSessionAccess: async () => undefined,
      requireFolderAccess: async () => undefined,
    },
    catalog: { renameSession: async () => undefined },
    commands: {} as never,
    createSession: async () => { throw new Error("createSession is not used"); },
    presets: {
      resolveStaticForNode,
      requireAvailable: () => undefined as never,
    },
    profiles: { listAgentProfiles: async () => ({}) },
    modelCatalog,
  });
  return { service, resolveStaticForNode };
}
