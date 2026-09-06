/**
 * @vitest-environment jsdom
 */

import { createElement, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useReasoningEffortSelection } from "./useReasoningEffortSelection";
import type { EffortPreset } from "../utils/reasoningEffort";

const OPUS: EffortPreset = {
  supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "xhigh",
};
const ASTRA: EffortPreset = {
  supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "medium",
};
/** Same preset id as OPUS, but a different node advertises a different default. */
const OPUS_ON_OTHER_NODE: EffortPreset = {
  supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "high",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

/** Renders the hook inside a real component so effects actually run. */
function Harness({ initialEffort }: { initialEffort?: string | null }) {
  const [presetKey, setPresetKey] = useState<string | null>("nodeA::claude-opus");
  const [preset, setPreset] = useState<EffortPreset | null>(null);
  const effort = useReasoningEffortSelection({
    presetKey,
    preset,
    ...(initialEffort !== undefined ? { initialEffort } : {}),
  });
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "effective" }, effort.effective ?? ""),
    createElement("span", { "data-testid": "options" }, effort.options.join(",")),
    createElement("span", { "data-testid": "submit" }, effort.submitValue ?? ""),
    createElement("span", { "data-testid": "unsupported" }, String(effort.unsupported)),
    createElement("button", {
      "data-testid": "load-opus",
      onClick: () => setPreset(OPUS),
    }),
    createElement("button", {
      "data-testid": "pick-low",
      onClick: () => effort.setSelected("low"),
    }),
    createElement("button", {
      "data-testid": "to-astra",
      onClick: () => {
        setPresetKey("nodeA::codex-6-astra");
        setPreset(ASTRA);
      },
    }),
    createElement("button", {
      "data-testid": "same-preset-other-node",
      onClick: () => {
        setPresetKey("nodeB::claude-opus");
        setPreset(OPUS_ON_OTHER_NODE);
      },
    }),
    createElement("button", {
      "data-testid": "catalogue-refresh",
      onClick: () => setPreset({ ...OPUS }),
    }),
  );
}

function text(testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

function click(testId: string): void {
  flushSync(() => {
    container
      .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
      ?.click();
  });
}

/** Passive effects (the refill) run after the sync flush, so let them settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(initialEffort?: string | null): void {
  flushSync(() => {
    root.render(createElement(Harness, { initialEffort }));
  });
}

describe("useReasoningEffortSelection", () => {
  it("shows nothing while the advertisement is still loading", () => {
    mount();
    expect(text("options")).toBe("");
    expect(text("effective")).toBe("");
  });

  it("adopts the advertised default once the catalogue arrives", () => {
    mount();
    click("load-opus");
    expect(text("effective")).toBe("xhigh");
    expect(text("options")).toBe("low,medium,high,xhigh,max");
    // Untouched: nothing is submitted, so the node applies the preset default.
    expect(text("submit")).toBe("");
  });

  it("does not wipe an inherited value while the catalogue is in flight", () => {
    // The bug this guards: keying on the loaded preset object made
    // isEffortSupported(null, 'low') false on the first commit and cleared it.
    mount("low");
    expect(text("effective")).toBe("low");
    click("load-opus");
    expect(text("effective")).toBe("low");
    expect(text("submit")).toBe("low");
  });

  it("refills the new preset's default when the model changes", async () => {
    mount();
    click("load-opus");
    click("pick-low");
    expect(text("effective")).toBe("low");

    click("to-astra");
    await settle();
    // Astra also advertises `low`, so "still supported" is not the trigger —
    // a different preset simply owns a different default.
    expect(text("effective")).toBe("medium");
    expect(text("submit")).toBe("");
  });

  it("refills when another node advertises the same preset id differently", async () => {
    mount();
    click("load-opus");
    click("pick-low");
    expect(text("effective")).toBe("low");

    click("same-preset-other-node");
    await settle();
    expect(text("effective")).toBe("high");
  });

  it("keeps a manual pick across a catalogue refresh of the same node+preset", async () => {
    mount();
    click("load-opus");
    click("pick-low");
    click("catalogue-refresh");
    await settle();
    // A refresh is not a switch; discarding the pick here would fight the user.
    expect(text("effective")).toBe("low");
    expect(text("submit")).toBe("low");
  });

  it("flags an unsupported carry-over instead of silently dropping it", () => {
    mount("ultra");
    click("load-opus");
    // Opus does not advertise ultra. The value is neither rewritten to xhigh nor
    // quietly omitted while the form still shows it: the surface must surface
    // `unsupported` and refuse to submit.
    expect(text("submit")).toBe("");
    expect(text("unsupported")).toBe("true");
  });

  it("clears the flag once a supported value is picked", () => {
    mount("ultra");
    click("load-opus");
    expect(text("unsupported")).toBe("true");
    click("pick-low");
    expect(text("unsupported")).toBe("false");
    expect(text("submit")).toBe("low");
  });
});
