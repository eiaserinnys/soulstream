import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ModelCatalog,
  UnknownModelPresetError,
  nodeEffortCapabilities,
} from "../../src/model_catalog.js";
import {
  UnsupportedReasoningEffortError,
  resolveEffortPreset,
  resolveReasoningEffortForCreate,
} from "../../src/task/task_reasoning_effort.js";
import {
  toClaudeSdkEffort,
  toCodexSdkEffort,
} from "../../src/engine/effort_boundary.js";
import { isReasoningEffort } from "../../src/engine/protocol.js";

const opus = {
  id: "claude-opus",
  supported_efforts: ["low", "medium", "high", "xhigh", "max"],
  default_effort: "xhigh",
} as const;

const astra = {
  id: "codex-6-astra",
  supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  default_effort: "medium",
} as const;

/** Kimi: vendor ignores output_config.effort, so the preset advertises nothing. */
const noEffortPreset = { id: "kimi-3" } as const;

describe("resolveReasoningEffortForCreate", () => {
  it("falls back to the preset default when the request omits effort", () => {
    expect(resolveReasoningEffortForCreate(opus, undefined)).toBe("xhigh");
    expect(resolveReasoningEffortForCreate(astra, undefined)).toBe("medium");
  });

  it("lets an explicit supported value win over the preset default", () => {
    expect(resolveReasoningEffortForCreate(opus, "low")).toBe("low");
    expect(resolveReasoningEffortForCreate(astra, "ultra")).toBe("ultra");
  });

  it("yields undefined (backend default) when neither side specifies", () => {
    expect(resolveReasoningEffortForCreate(noEffortPreset, undefined)).toBeUndefined();
    expect(resolveReasoningEffortForCreate(undefined, undefined)).toBeUndefined();
  });

  it("rejects an effort the preset does not advertise instead of downgrading", () => {
    expect(() => resolveReasoningEffortForCreate(opus, "ultra")).toThrow(
      UnsupportedReasoningEffortError,
    );
    // The whole point: no silent substitution.
    try {
      resolveReasoningEffortForCreate(opus, "ultra");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedReasoningEffortError);
      expect((error as UnsupportedReasoningEffortError).code).toBe(
        "UNSUPPORTED_REASONING_EFFORT",
      );
      expect((error as UnsupportedReasoningEffortError).message).toContain("xhigh");
    }
  });

  it("rejects any explicit effort for a preset with no effort control", () => {
    expect(() => resolveReasoningEffortForCreate(noEffortPreset, "xhigh")).toThrow(
      UnsupportedReasoningEffortError,
    );
  });

  it("rejects legacy minimal for new sessions while keeping it readable", () => {
    expect(() => resolveReasoningEffortForCreate(opus, "minimal")).toThrow(
      UnsupportedReasoningEffortError,
    );
    expect(isReasoningEffort("minimal")).toBe(true);
  });
});

describe("resolveEffortPreset", () => {
  const catalog = {
    resolve(id: string) {
      if (id === "claude-opus") return opus as never;
      throw new UnknownModelPresetError(id);
    },
  };

  it("returns the preset for a known id", () => {
    expect(resolveEffortPreset("claude-opus", catalog)?.id).toBe("claude-opus");
  });

  it("degrades to undefined for a removed preset rather than failing creation", () => {
    expect(resolveEffortPreset("gone", catalog)).toBeUndefined();
    expect(resolveEffortPreset(null, catalog)).toBeUndefined();
    expect(resolveEffortPreset("claude-opus", undefined)).toBeUndefined();
  });

  it("still makes an explicit effort a hard error once the preset is unknown", () => {
    const preset = resolveEffortPreset("gone", catalog);
    expect(() => resolveReasoningEffortForCreate(preset, "high")).toThrow(
      UnsupportedReasoningEffortError,
    );
  });
});

describe("adapter boundary narrowing", () => {
  it("passes values each SDK can express", () => {
    expect(toClaudeSdkEffort("xhigh")).toBe("xhigh");
    expect(toClaudeSdkEffort("max")).toBe("max");
    expect(toCodexSdkEffort("xhigh")).toBe("xhigh");
    expect(toCodexSdkEffort("minimal")).toBe("minimal");
  });

  it("drops values the SDK union cannot represent instead of casting", () => {
    // Claude has no minimal/ultra; the legacy Codex SDK has no max/ultra.
    expect(toClaudeSdkEffort("minimal")).toBeUndefined();
    expect(toClaudeSdkEffort("ultra")).toBeUndefined();
    expect(toCodexSdkEffort("max")).toBeUndefined();
    expect(toCodexSdkEffort("ultra")).toBeUndefined();
  });

  it("passes undefined through as undefined", () => {
    expect(toClaudeSdkEffort(undefined)).toBeUndefined();
    expect(toCodexSdkEffort(undefined)).toBeUndefined();
  });
});

describe("model catalog effort advertisement", () => {
  function catalogFrom(yaml: string): ModelCatalog {
    const path = join(
      mkdtempSync(join(tmpdir(), "effort-catalog-")),
      "model-catalog.yaml",
    );
    writeFileSync(path, yaml, "utf-8");
    return new ModelCatalog(path);
  }

  it("advertises both effort fields", () => {
    const catalog = catalogFrom(`presets:
  - id: claude-opus
    label: Claude - Opus
    backend: claude
    model: opus
    supported_efforts: [low, medium, high, xhigh, max]
    default_effort: xhigh
`);
    const [preset] = catalog.advertise({});
    expect(preset?.default_effort).toBe("xhigh");
    expect(preset?.supported_efforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("loads a preset with neither field (auto / backend default)", () => {
    const catalog = catalogFrom(`presets:
  - id: kimi-3
    label: Kimi - 3
    backend: claude
    model: k3
`);
    const [preset] = catalog.advertise({});
    expect(preset?.supported_efforts).toBeUndefined();
    expect(preset?.default_effort).toBeUndefined();
  });

  it("narrows advertised efforts to what the active transport can carry", () => {
    // The legacy Codex SDK transport cannot express max/ultra. Advertising them
    // there would let the UI offer a value the engine then silently drops.
    const yaml = `presets:
  - id: codex-5.6-sol
    label: Codex - 5.6 Sol
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [low, medium, high, xhigh, max, ultra]
    default_effort: xhigh
`;
    const path = join(mkdtempSync(join(tmpdir(), "effort-transport-")), "c.yaml");
    writeFileSync(path, yaml, "utf-8");

    const appServer = new ModelCatalog(path, undefined, nodeEffortCapabilities("app-server"));
    expect(appServer.advertise({})[0]?.supported_efforts).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);

    const legacySdk = new ModelCatalog(path, undefined, nodeEffortCapabilities("sdk"));
    expect(legacySdk.advertise({})[0]?.supported_efforts).toEqual([
      "low", "medium", "high", "xhigh",
    ]);
    expect(legacySdk.advertise({})[0]?.default_effort).toBe("xhigh");

    // Advertisement and create-time validation read the same narrowed list.
    expect(() => resolveReasoningEffortForCreate(
      legacySdk.resolve("codex-5.6-sol"),
      "ultra",
    )).toThrow(UnsupportedReasoningEffortError);
    expect(resolveReasoningEffortForCreate(
      appServer.resolve("codex-5.6-sol"),
      "ultra",
    )).toBe("ultra");
  });

  it("drops a default the transport cannot deliver instead of clamping it", () => {
    const yaml = `presets:
  - id: p
    label: P
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [xhigh, max]
    default_effort: max
`;
    const path = join(mkdtempSync(join(tmpdir(), "effort-transport2-")), "c.yaml");
    writeFileSync(path, yaml, "utf-8");
    const legacySdk = new ModelCatalog(path, undefined, nodeEffortCapabilities("sdk"));
    const [preset] = legacySdk.advertise({});
    expect(preset?.supported_efforts).toEqual(["xhigh"]);
    // Not silently rewritten to xhigh: the preset simply has no default now.
    expect(preset?.default_effort).toBeUndefined();
  });

  it("fails fast when default_effort is not in supported_efforts", () => {
    const catalog = catalogFrom(`presets:
  - id: bad
    label: Bad
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [low, medium]
    default_effort: xhigh
`);
    expect(() => catalog.list()).toThrow(/default_effort/);
  });

  it("fails fast when default_effort has no supported_efforts", () => {
    const catalog = catalogFrom(`presets:
  - id: bad
    label: Bad
    backend: codex
    model: gpt-5.6-sol
    default_effort: xhigh
`);
    expect(() => catalog.list()).toThrow(/supported_efforts/);
  });
});
