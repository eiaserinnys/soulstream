/**
 * @vitest-environment jsdom
 *
 * The picker's DOM boundary. `refreshReasoningEfforts` both reads the current
 * selection off the page and writes the resolved view back, so two refreshes
 * that overlap in flight can only be judged against a real `<select>`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  populateReasoningEfforts,
  refreshReasoningEfforts,
  resetReasoningEffortsForTest,
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

function body(url: string): unknown {
  return url.includes("model-presets")
    ? { model_presets: [OPUS, ASTRA] }
    : { agents: AGENTS };
}

/** Every response waits for its release; `pending` is FIFO. */
function deferredFetch() {
  const pending: (() => void)[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const payload = body(String(input));
    return new Promise((resolve) => {
      pending.push(() => resolve({ ok: true, json: async () => payload } as Response));
    });
  }));
  return {
    releaseAll() {
      for (const release of pending.splice(0)) release();
    },
  };
}

function immediateFetch() {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve({
    ok: true,
    json: async () => body(String(input)),
  } as Response)));
}

function picker(): HTMLSelectElement {
  const select = document.querySelector<HTMLSelectElement>("#reasoning-effort");
  if (!select) throw new Error("picker missing");
  return select;
}

beforeEach(() => {
  document.body.innerHTML = `
    <select id="reasoning-effort"><option value="">Server default</option></select>
    <small id="reasoning-effort-note" hidden></small>
  `;
  resetReasoningEffortsForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("effort picker DOM boundary", () => {
  it("does not re-adopt the previous scope's value when two refreshes overlap", async () => {
    immediateFetch();
    await populateReasoningEfforts(scope("roselin"), "low");
    expect(picker().value).toBe("low");

    // Switch profile; the response has not arrived yet, so the picker still
    // displays opus's `low`.
    const slow = deferredFetch();
    const first = refreshReasoningEfforts(scope("astra"));

    // A second commit on the *same* new scope (only the token changed) lands
    // first. It must not read the stale `low` off the picker and treat it as
    // astra's own selection.
    immediateFetch();
    await refreshReasoningEfforts(scope("astra", { bearerToken: "token-2" }));

    slow.releaseAll();
    await first;

    expect(picker().value).toBe("");
    expect(picker().options[0]?.textContent).toBe("Preset default (Medium)");
  });
});
