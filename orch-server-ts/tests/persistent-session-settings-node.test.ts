import { describe, expect, it } from "vitest";

import {
  parsePersistentSettingsPatch,
  readStoredPersistentSettings,
  readPersistentPendingTarget,
} from "@soulstream/wire-schema/persistent-session-settings";
import { persistentSessionSettingsTools } from "@soulstream/mcp-contract";

describe("persistent session model node selection", () => {
  it("trims node ids and distinguishes the same preset on different nodes", () => {
    const parsed = parsePersistentSettingsPatch({
      fallback_models: [
        { model_preset: "claude-opus", reasoning_effort: "medium", node_id: " eias-linegames-wsl " },
        { model_preset: "claude-opus", reasoning_effort: "medium", node_id: "eias-linegames" },
      ],
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        fallback_models: [
          { model_preset: "claude-opus", reasoning_effort: "medium", node_id: "eias-linegames-wsl" },
          { model_preset: "claude-opus", reasoning_effort: "medium", node_id: "eias-linegames" },
        ],
      },
    });
  });

  it("rejects duplicate candidates on the same node and blank node ids", () => {
    expect(parsePersistentSettingsPatch({ fallback_models: [
      { model_preset: "claude-opus", node_id: "node-a" },
      { model_preset: "claude-opus", node_id: " node-a " },
    ] })).toMatchObject({ ok: false });
    expect(parsePersistentSettingsPatch({ default_model: {
      model_preset: "claude-opus", node_id: "  ",
    } })).toMatchObject({ ok: false });
  });

  it("preserves node ids when reading stored settings and pending targets", () => {
    expect(readStoredPersistentSettings([
      { type: "persistent_settings", value: {
        default_model: { model_preset: "gemini-4-argon", node_id: "eias-linegames-wsl" },
        fallback_models: [
          { model_preset: "claude-opus", node_id: "eias-linegames-wsl" },
          { model_preset: "codex-6.1-sol", node_id: "eias-linegames" },
        ],
      } },
    ])).toMatchObject({
      default_model: { model_preset: "gemini-4-argon", node_id: "eias-linegames-wsl" },
      fallback_models: [
        { model_preset: "claude-opus", node_id: "eias-linegames-wsl" },
        { model_preset: "codex-6.1-sol", node_id: "eias-linegames" },
      ],
    });
    expect(readPersistentPendingTarget([{ type: "persistent_generation", value: {
      pending: { target_model_preset: "codex-6.1-sol", target_node_id: "eias-linegames" },
    } }])).toEqual({
      target_model_preset: "codex-6.1-sol",
      target_reasoning_effort: null,
      target_node_id: "eias-linegames",
    });
  });

  it("accepts node_id in the strict MCP tool model schema", () => {
    const schema = persistentSessionSettingsTools.update_persistent_session_settings.config.inputSchema;
    expect(schema.default_model.parse({
      model_preset: "gemini-4-argon", reasoning_effort: "medium", node_id: "eias-linegames-wsl",
    })).toMatchObject({ node_id: "eias-linegames-wsl" });
    expect(() => schema.default_model.parse({
      model_preset: "gemini-4-argon", node_id: "eias-linegames-wsl", unexpected: true,
    })).toThrow();
  });
});
