import { describe, expect, it } from "vitest";

import {
  defaultEffortForPreset,
  effortOptionsForPreset,
  isEffortSupported,
  presetSupportsEffort,
  reasoningEffortForSubmit,
  selectedAgentBackend,
} from "./reasoningEffort";

const claudeOpus = {
  supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "xhigh",
};
const codexAstra = {
  supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "medium",
};
/** A preset whose model has no effort control (e.g. Kimi, haiku). */
const noEffort = {};

describe("reasoning effort UI helper", () => {
  it("offers exactly what the preset advertises, regardless of backend", () => {
    // The old gate was hardcoded to `backend === "codex"`, which hid the control
    // for every Claude preset.
    expect(presetSupportsEffort(claudeOpus)).toBe(true);
    expect(presetSupportsEffort(codexAstra)).toBe(true);
    expect(effortOptionsForPreset(claudeOpus)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortOptionsForPreset(codexAstra)).toContain("ultra");
  });

  it("treats a preset with no advertised efforts as auto/backend-default", () => {
    expect(presetSupportsEffort(noEffort)).toBe(false);
    expect(presetSupportsEffort(null)).toBe(false);
    expect(effortOptionsForPreset(noEffort)).toEqual([]);
    expect(defaultEffortForPreset(noEffort)).toBeUndefined();
  });

  it("never offers minimal, because no model advertises it", () => {
    expect(effortOptionsForPreset(claudeOpus)).not.toContain("minimal");
    expect(effortOptionsForPreset(codexAstra)).not.toContain("minimal");
  });

  it("reports the preset default rather than a client-side constant", () => {
    expect(defaultEffortForPreset(claudeOpus)).toBe("xhigh");
    expect(defaultEffortForPreset(codexAstra)).toBe("medium");
  });

  it("submits an explicit supported value and omits when unset", () => {
    expect(reasoningEffortForSubmit(claudeOpus, "low")).toBe("low");
    expect(reasoningEffortForSubmit(claudeOpus, null)).toBeUndefined();
    expect(reasoningEffortForSubmit(claudeOpus, undefined)).toBeUndefined();
  });

  it("omits rather than downgrades an unsupported carry-over value", () => {
    // Switching from astra (ultra) to a preset without ultra must not silently
    // become xhigh — it must fall back to the preset default server-side.
    expect(reasoningEffortForSubmit(claudeOpus, "ultra")).toBeUndefined();
    expect(isEffortSupported(claudeOpus, "ultra")).toBe(false);
    expect(isEffortSupported(codexAstra, "ultra")).toBe(true);
  });

  it("keeps a stale legacy value visible as unsupported", () => {
    expect(isEffortSupported(claudeOpus, "minimal")).toBe(false);
  });

  it("finds the selected agent backend and returns null when absent", () => {
    const agents = [
      { id: "a", backend: "claude" },
      { id: "b", backend: "codex" },
    ];
    expect(selectedAgentBackend(agents, "b")).toBe("codex");
    expect(selectedAgentBackend(agents, "zzz")).toBeNull();
    expect(selectedAgentBackend(agents, "")).toBeNull();
  });
});
