import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openModelCatalogFile } from "@soulstream/model-catalog/file-loader";

import {
  ModelCatalog,
  UnknownModelPresetError,
  assertCatalogDefaultsDeliverable,
  nodeEffortCapabilities,
  type ModelCatalogOptions,
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
    expect(resolveReasoningEffortForCreate(astra, "max")).toBe("max");
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
  it("passes values allowed by each SDK adapter", () => {
    expect(toClaudeSdkEffort("xhigh")).toBe("xhigh");
    expect(toClaudeSdkEffort("max")).toBe("max");
    expect(toCodexSdkEffort("xhigh")).toBe("xhigh");
    expect(toCodexSdkEffort("minimal")).toBe("minimal");
    expect(toCodexSdkEffort("max")).toBe("max");
  });

  it("drops values excluded by each SDK adapter instead of casting", () => {
    // Claude cannot express minimal/ultra; Soulstream keeps Codex ultra out of
    // its SDK transport policy even though the updated SDK type declares it.
    expect(toClaudeSdkEffort("minimal")).toBeUndefined();
    expect(toClaudeSdkEffort("ultra")).toBeUndefined();
    expect(toCodexSdkEffort("ultra")).toBeUndefined();
  });

  it("passes undefined through as undefined", () => {
    expect(toClaudeSdkEffort(undefined)).toBeUndefined();
    expect(toCodexSdkEffort(undefined)).toBeUndefined();
  });
});

describe("model catalog effort advertisement", () => {
  function catalogYaml(presets: string): string {
    const firstId = /- id: (\S+)/.exec(presets)?.[1] ?? "missing";
    return `schema_version: 1
groups: []
presets:
${presets}
models: []
price_snapshot:
  price_version: test-v1
  as_of: "2026-10-19"
  checked_at: "2026-10-19"
  currency: USD
  unit: per_1m_tokens
  model_mapping_version: exact-provider-model-v1
  refreshed_model_rows: {}
  sources: {}
  assumptions: []
persistent_defaults:
  model_preset: ${firstId}
  fallback_models: []
`;
  }

  function openCatalog(path: string, options: ModelCatalogOptions = {}): ModelCatalog {
    const store = openModelCatalogFile({
      path,
      ...(options.logger ? { logger: options.logger } : {}),
      validate: (catalog) => assertCatalogDefaultsDeliverable(catalog, options.effortCapabilities),
    });
    return new ModelCatalog(store, options);
  }

  function catalogFrom(presets: string, options: ModelCatalogOptions = {}): ModelCatalog {
    const path = join(
      mkdtempSync(join(tmpdir(), "effort-catalog-")),
      "model-catalog.yaml",
    );
    writeFileSync(path, catalogYaml(presets), "utf-8");
    return openCatalog(path, options);
  }

  it("advertises both effort fields", () => {
    const catalog = catalogFrom(`  - id: claude-opus
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
    const catalog = catalogFrom(`  - id: kimi-3
    label: Kimi - 3
    backend: claude
    model: k3
`);
    const [preset] = catalog.advertise({});
    expect(preset?.supported_efforts).toBeUndefined();
    expect(preset?.default_effort).toBeUndefined();
  });

  it("narrows advertised efforts to what the active transport can carry", () => {
    // The SDK transport can express max but not ultra. Advertisement must stay
    // narrower than the app-server path when a preset advertises both.
    const presets = `  - id: codex-5.6-sol
    label: Codex - 5.6 Sol
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [low, medium, high, xhigh, max, ultra]
    default_effort: xhigh
`;
    const appServer = catalogFrom(presets, {
      effortCapabilities: nodeEffortCapabilities("app-server"),
    });
    expect(appServer.advertise({})[0]?.supported_efforts).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);

    const legacySdk = catalogFrom(presets, {
      effortCapabilities: nodeEffortCapabilities("sdk"),
    });
    expect(legacySdk.advertise({})[0]?.supported_efforts).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
    expect(legacySdk.advertise({})[0]?.default_effort).toBe("xhigh");

    // Advertisement and create-time validation read the same narrowed list.
    expect(() => resolveReasoningEffortForCreate(
      legacySdk.resolve("codex-5.6-sol"),
      "ultra",
    )).toThrow(UnsupportedReasoningEffortError);
    expect(resolveReasoningEffortForCreate(
      legacySdk.resolve("codex-5.6-sol"),
      "max",
    )).toBe("max");
    expect(resolveReasoningEffortForCreate(
      appServer.resolve("codex-5.6-sol"),
      "ultra",
    )).toBe("ultra");
  });

  it("rejects max when the selected model preset does not advertise it", () => {
    const catalog = catalogFrom(`  - id: codex-basic
    label: Codex Basic
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [low, medium, high, xhigh]
    default_effort: xhigh
`, { effortCapabilities: nodeEffortCapabilities("sdk") });

    expect(() => resolveReasoningEffortForCreate(
      catalog.resolve("codex-basic"),
      "max",
    )).toThrow(UnsupportedReasoningEffortError);
  });

  it("treats a default the transport cannot deliver as a configuration error", () => {
    const path = join(mkdtempSync(join(tmpdir(), "effort-transport2-")), "c.yaml");
    writeFileSync(path, catalogYaml(`  - id: p
    label: P
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [xhigh, ultra]
    default_effort: ultra
`), "utf-8");
    // Neither clamped to xhigh nor quietly dropped to "backend default": the
    // file asks for something this node cannot do, and the startup load fails.
    expect(() => openCatalog(path, {
      effortCapabilities: nodeEffortCapabilities("sdk"),
    })).toThrow(/default_effort/);

    // The same file is fine on a transport that can carry `ultra`.
    const appServer = openCatalog(path, {
      effortCapabilities: nodeEffortCapabilities("app-server"),
    });
    expect(appServer.advertise({})[0]?.default_effort).toBe("ultra");
  });

  it("keeps serving the last good catalogue when a reload introduces one", () => {
    // It is a config error, but the catalogue is re-read on every call: a bad
    // edit must not take a running node dark (registration and every session
    // creation read this list), it must fall back like any malformed file.
    const path = join(mkdtempSync(join(tmpdir(), "effort-transport3-")), "c.yaml");
    const good = catalogYaml(`  - id: p
    label: P
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [xhigh]
    default_effort: xhigh
`);
    writeFileSync(path, good, "utf-8");
    const logger = { error: () => {}, warn: () => {} };
    const catalog = openCatalog(path, {
      logger,
      effortCapabilities: nodeEffortCapabilities("sdk"),
    });
    expect(catalog.list()[0]?.default_effort).toBe("xhigh");

    writeFileSync(path, good.replace("default_effort: xhigh", "default_effort: ultra")
      .replace("[xhigh]", "[xhigh, ultra]"), "utf-8");
    expect(catalog.list()[0]?.default_effort).toBe("xhigh");
  });

  it("fails fast when default_effort is not in supported_efforts", () => {
    expect(() => catalogFrom(`  - id: bad
    label: Bad
    backend: codex
    model: gpt-5.6-sol
    supported_efforts: [low, medium]
    default_effort: xhigh
`)).toThrow(/default_effort/);
  });

  it("fails fast when default_effort has no supported_efforts", () => {
    expect(() => catalogFrom(`  - id: bad
    label: Bad
    backend: codex
    model: gpt-5.6-sol
    default_effort: xhigh
`)).toThrow(/supported_efforts/);
  });
});
