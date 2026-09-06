import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetReasoningEffortsForTest,
  resolveEffortPickerView,
  selectionForScope,
  type EffortScope,
} from "./options_effort.js";

const OPUS = {
  id: "claude-opus",
  label: "Claude - Opus",
  supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "xhigh",
};
const ASTRA = {
  id: "codex-6-astra",
  label: "Codex - 6 Astra",
  supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "medium",
};

const AGENTS = [
  { id: "roselin", name: "roselin", default_preset: "claude-opus" },
  { id: "astra", name: "astra", default_preset: "codex-6-astra" },
];

function scope(profile: string, overrides: Partial<EffortScope> = {}): EffortScope {
  return {
    baseUrl: "https://soulstream.example",
    nodeId: "eiaserinnys",
    profile,
    bearerToken: "token-1",
    ...overrides,
  };
}

/** Resolves each response only when the returned release() is called. */
function deferredFetch() {
  const releases: (() => void)[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("model-presets")
      ? { model_presets: [OPUS, ASTRA] }
      : { agents: AGENTS };
    return new Promise((resolve) => {
      releases.push(() => resolve({ ok: true, json: async () => body } as Response));
    });
  }));
  return {
    releaseAll() {
      const pending = releases.splice(0);
      for (const release of pending) release();
    },
  };
}

function immediateFetch(presets: unknown[] = [OPUS, ASTRA], agents: unknown[] = AGENTS) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve({
    ok: true,
    json: async () => (String(input).includes("model-presets")
      ? { model_presets: presets }
      : { agents }),
  } as Response)));
}

beforeEach(() => {
  resetReasoningEffortsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("effort picker scope handling", () => {
  it("keeps the saved value on the initial load", async () => {
    immediateFetch();
    const view = await resolveEffortPickerView(scope("roselin"), "low");
    expect(view?.selected).toBe("low");
    expect(view?.options[0]?.label).toBe("Preset default (X High)");
    expect(view?.note).toBe("");
  });

  it("drops the previous pick when the profile moves to another preset", async () => {
    immediateFetch();
    await resolveEffortPickerView(scope("roselin"), "low");

    // The saved value belongs to opus. Astra advertises `low` too, so "still
    // supported" is not the test: a different preset owns a different default.
    const selected = selectionForScope(scope("astra"), "low");
    expect(selected).toBe("");

    const view = await resolveEffortPickerView(scope("astra"), selected);
    expect(view?.selected).toBe("");
    expect(view?.options[0]?.label).toBe("Preset default (Medium)");
  });

  it("drops the previous pick when the node changes", async () => {
    immediateFetch();
    await resolveEffortPickerView(scope("roselin"), "low");
    expect(selectionForScope(scope("roselin", { nodeId: "wsl" }), "low")).toBe("");
  });

  it("keeps the on-screen pick when only the token or URL changes", async () => {
    immediateFetch();
    await resolveEffortPickerView(scope("roselin"), "low");

    // Same node and profile: this is a re-query, not a scope change. Re-reading
    // the saved value here would throw away an unsaved pick.
    expect(selectionForScope(scope("roselin", { bearerToken: "token-2" }), "max"))
      .toBe("max");
    expect(selectionForScope(scope("roselin", { baseUrl: "https://other.example" }), "max"))
      .toBe("max");
  });

  it("ignores a late response from a superseded scope", async () => {
    const slow = deferredFetch();
    const stale = resolveEffortPickerView(scope("roselin"), "low");

    immediateFetch();
    const fresh = await resolveEffortPickerView(scope("astra"), "");
    expect(fresh?.options[0]?.label).toBe("Preset default (Medium)");

    // The earlier request finishes last. It must not become the rendered view.
    slow.releaseAll();
    expect(await stale).toBeNull();
  });

  it("offers only the server default when the profile's preset is unknown", async () => {
    immediateFetch();
    const view = await resolveEffortPickerView(scope("ghost"), "ultra");
    // No node-wide union: an unresolved profile means we know nothing about what
    // it can run.
    expect(view?.options.map((option) => option.value)).toEqual(["", "ultra"]);
    expect(view?.note).toContain("Could not tell which model preset");
    expect(view?.note).toContain("Check the profile and Node ID");
  });

  it("reports an unadvertised preset as observed, not as a model capability", async () => {
    immediateFetch([{ id: "claude-opus", label: "Claude - Opus" }], AGENTS);
    const view = await resolveEffortPickerView(scope("roselin"), "");
    expect(view?.note).toBe(
      "Claude - Opus advertises no effort choices; the backend default applies.",
    );
  });
});
