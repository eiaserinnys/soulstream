import { describe, expect, it } from "vitest";

import { InMemoryNodeRegistry } from "../src/node/registry.js";
import {
  selectNodeForSessionCreate,
  SessionCreateNodeSelectionError,
} from "../src/session/session_create_node_selector.js";

function registryWithPreset(): InMemoryNodeRegistry {
  const registry = new InMemoryNodeRegistry();
  registry.registerNode({
    type: "node_register",
    node_id: "node-a",
    agents: [
      {
        id: "roselin",
        backend: "claude",
        default_preset: "codex-sol",
      },
    ],
    supported_backends: ["claude", "codex"],
    model_presets: [
      {
        id: "codex-sol",
        label: "Codex - 5.6 Sol",
        backend: "codex",
        available: true,
        usage_provider: "codex",
        usage_model_id: "gpt-5.6-sol",
      },
    ],
  });
  return registry;
}

describe("session create node selection with model presets", () => {
  it("selects the explicit preset backend instead of the profile backend", () => {
    const selected = selectNodeForSessionCreate(registryWithPreset(), {
      nodeId: "node-a",
      profileId: "roselin",
      modelPresetId: "codex-sol",
    });

    expect(selected.backend).toBe("codex");
  });

  it("uses the profile default preset only when a legacy model was not specified", () => {
    const registry = registryWithPreset();

    expect(selectNodeForSessionCreate(registry, {
      nodeId: "node-a",
      profileId: "roselin",
    })).toMatchObject({
      backend: "codex",
      modelPresetId: "codex-sol",
    });
    expect(selectNodeForSessionCreate(registry, {
      nodeId: "node-a",
      profileId: "roselin",
      legacyModelSpecified: true,
    }).backend).toBe("claude");
  });

  it("rejects an unadvertised preset with a 400 contract error", () => {
    try {
      selectNodeForSessionCreate(registryWithPreset(), {
        nodeId: "node-a",
        profileId: "roselin",
        modelPresetId: "missing",
      });
      throw new Error("expected selection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionCreateNodeSelectionError);
      expect(error).toMatchObject({
        statusCode: 400,
        code: "MODEL_PRESET_NOT_FOUND",
      });
    }
  });
});
