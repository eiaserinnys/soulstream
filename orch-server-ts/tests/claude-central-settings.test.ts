import { describe, expect, it } from "vitest";

import {
  applySettingsPatch,
  defaultCentralPoolSettings,
  parseSettings,
} from "../src/claude_central/settings_repository.js";

describe("central Claude settings merge", () => {
  it("changes default_receive only when it is given", () => {
    const current = { default_receive: true, nodes: { "node-a": false } };

    expect(applySettingsPatch(current, { nodes: { "node-b": true } })).toEqual({
      default_receive: true,
      nodes: { "node-a": false, "node-b": true },
    });
    expect(applySettingsPatch(current, { default_receive: false })).toEqual({
      default_receive: false,
      nodes: { "node-a": false },
    });
  });

  it("sets true/false keys, removes only null keys, and leaves unmentioned keys", () => {
    const current = {
      default_receive: true,
      nodes: { "node-a": false, "node-b": true, "node-c": false },
    };

    expect(applySettingsPatch(current, {
      nodes: { "node-a": true, "node-b": null, "node-c": null, "node-d": false },
    })).toEqual({
      default_receive: true,
      nodes: { "node-a": true, "node-d": false },
    });
  });

  it("ignores empty node ids and keeps the parse rules for stored values", () => {
    expect(applySettingsPatch(defaultCentralPoolSettings(), {
      nodes: { "": true, "node-a": false },
    }).nodes).toEqual({ "node-a": false });

    expect(parseSettings({
      default_receive: false,
      nodes: { "node-a": true, "node-b": "yes", "": true },
    })).toEqual({ default_receive: false, nodes: { "node-a": true } });
    expect(parseSettings(null)).toEqual({ default_receive: true, nodes: {} });
  });
});
