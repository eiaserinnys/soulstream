import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import {
  loadModelCatalog,
  ModelCatalog,
  ModelCatalogSchema,
} from "../src/model_catalog.js";

function withTempCatalog<T>(content: string, fn: (catalogPath: string) => T): T {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-catalog-"));
  const catalogPath = path.join(directory, "model-catalog.yaml");
  fs.writeFileSync(catalogPath, content, "utf-8");
  try {
    return fn(catalogPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("ModelCatalog", () => {
  it("ships the nine agreed preset ids in the example catalog", () => {
    const catalog = new ModelCatalog(
      path.resolve(process.cwd(), "config/model-catalog.yaml.example"),
    );

    expect(catalog.list().map((preset) => preset.id)).toEqual([
      "claude-sonnet",
      "claude-opus",
      "claude-fable",
      "codex-5.6-sol",
      "codex-5.6-lunar",
      "codex-5.6-terra",
      "codex-5.3-spark",
      "kimi-2",
      "kimi-3",
    ]);
  });

  it("loads preset definitions and resolves by stable id", () => {
    withTempCatalog(
      `
presets:
  - id: claude-opus
    label: Claude - Opus
    backend: claude
    model: opus
  - id: kimi-2
    label: Kimi - 2
    backend: claude
    model: kimi-for-coding
    env:
      ANTHROPIC_BASE_URL: https://api.kimi.com/coding/
      ANTHROPIC_API_KEY: \${KIMI_API_KEY}
`,
      (catalogPath) => {
        const catalog = new ModelCatalog(catalogPath);

        expect(catalog.list()).toEqual([
          {
            id: "claude-opus",
            label: "Claude - Opus",
            backend: "claude",
            model: "opus",
          },
          {
            id: "kimi-2",
            label: "Kimi - 2",
            backend: "claude",
            model: "kimi-for-coding",
            env: {
              ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
              ANTHROPIC_API_KEY: "${KIMI_API_KEY}",
            },
          },
        ]);
        expect(catalog.resolve("kimi-2")).toMatchObject({
          id: "kimi-2",
          backend: "claude",
          model: "kimi-for-coding",
        });
      },
    );
  });

  it("re-reads the yaml for each resolution", () => {
    withTempCatalog(
      `
presets:
  - id: claude-fable
    label: Claude - Fable
    backend: claude
    model: fable
`,
      (catalogPath) => {
        const catalog = new ModelCatalog(catalogPath);
        expect(catalog.resolve("claude-fable").model).toBe("fable");

        fs.writeFileSync(
          catalogPath,
          `
presets:
  - id: claude-fable
    label: Claude - Fable
    backend: claude
    model: claude-fable-5[1m]
`,
          "utf-8",
        );

        expect(catalog.resolve("claude-fable").model).toBe("claude-fable-5[1m]");
      },
    );
  });

  it("degrades a missing catalog file to an empty additive catalog", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-catalog-missing-"));
    try {
      const catalogPath = path.join(directory, "model-catalog.yaml");
      const warn = vi.fn();
      const catalog = loadModelCatalog(catalogPath, {
        error: vi.fn(),
        warn,
      });

      expect(catalog.list()).toEqual([]);
      expect(catalog.advertise({})).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        { path: catalogPath },
        "model catalog not found; advertising no presets",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps malformed catalog content as an explicit startup failure", () => {
    withTempCatalog("presets: not-a-list\n", (catalogPath) => {
      expect(() => loadModelCatalog(catalogPath)).toThrow(ZodError);
    });
  });

  it("keeps the last successful catalog and logs when a runtime reload is malformed", () => {
    withTempCatalog(
      `
presets:
  - id: claude-opus
    label: Claude - Opus
    backend: claude
    model: opus
`,
      (catalogPath) => {
        const error = vi.fn();
        const catalog = loadModelCatalog(catalogPath, { error });
        expect(catalog.resolve("claude-opus").model).toBe("opus");

        fs.writeFileSync(catalogPath, "presets: not-a-list\n", "utf-8");

        expect(catalog.list()).toEqual([{
          id: "claude-opus",
          label: "Claude - Opus",
          backend: "claude",
          model: "opus",
        }]);
        expect(catalog.advertise({})).toMatchObject([{
          id: "claude-opus",
          available: true,
        }]);
        expect(error).toHaveBeenCalledWith(
          expect.objectContaining({
            catalogPath,
            err: expect.any(ZodError),
          }),
          "Model catalog reload failed; using the last successful catalog",
        );
      },
    );
  });

  it("advertises unresolved env without exposing values and excludes API-key presets from usage", () => {
    withTempCatalog(
      `
presets:
  - id: claude-fable
    label: Claude - Fable
    backend: claude
    model: claude-fable-5[1m]
    usage_model_id: fable
  - id: kimi-2
    label: Kimi - 2
    backend: claude
    model: kimi-for-coding
    env:
      ANTHROPIC_BASE_URL: https://api.kimi.com/coding/
      ANTHROPIC_API_KEY: \${KIMI_API_KEY}
`,
      (catalogPath) => {
        const catalog = new ModelCatalog(catalogPath);

        expect(catalog.advertise({})).toEqual([
          {
            id: "claude-fable",
            label: "Claude - Fable",
            backend: "claude",
            available: true,
            usage_provider: "claude",
            usage_model_id: "fable",
          },
          {
            id: "kimi-2",
            label: "Kimi - 2",
            backend: "claude",
            available: false,
            reason: "env_unresolved",
            usage_provider: null,
          },
        ]);
        expect(JSON.stringify(catalog.advertise({}))).not.toContain(
          "https://api.kimi.com",
        );
      },
    );
  });

  it("rejects duplicate preset ids", () => {
    expect(() =>
      ModelCatalogSchema.parse({
        presets: [
          { id: "claude-opus", label: "One", backend: "claude", model: "opus" },
          { id: "claude-opus", label: "Two", backend: "claude", model: "opus-2" },
        ],
      }),
    ).toThrow(ZodError);
  });

  it("fails explicitly for an unknown preset id", () => {
    withTempCatalog("presets: []\n", (catalogPath) => {
      const catalog = new ModelCatalog(catalogPath);
      expect(() => catalog.resolve("missing")).toThrow(
        "Unknown model preset: missing",
      );
    });
  });
});
