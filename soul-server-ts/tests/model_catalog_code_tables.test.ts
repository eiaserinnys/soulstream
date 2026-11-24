/** Model names belong in the catalog, not in production code or configuration. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_PATH = path.join(REPO_ROOT, "packages", "model-catalog", "data", "model-catalog.yaml");
const SCAN_DIRECTORIES = [
  "soul-server-ts/src", "soul-server-ts/config", "orch-server-ts/src", "orch-server-ts/config",
  "unified-dashboard/client", "soul-app/src", "soul-app/targets", "install", "portable-node",
  "deploy", "scripts", "soul-desktop/src", "chrome-extension/src",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".js", ".json", ".yaml", ".yml", ".sh", ".py", ".swift"]);
// Tests, fixtures, component review, and e2e contain synthetic data rather than production inputs.
const EXCLUDED_SEGMENTS = new Set(["tests", "__tests__", "fixtures", "component-review", "e2e"]);
// The catalog is the source of truth. Seed data and stage 1 preserve historical installation inputs;
// examples and experimental or endurance tools are not production configuration.
const EXCLUDED_PATHS = [
  "packages/model-catalog/data", "install/tests", "install/seed", "install/stage1-managed-presets.json",
  "soul-server-ts/config/agents.yaml.example", "scripts/lab-node", "soul-server-ts/scripts/staging-soak",
];
// These files are used only by the component review page and provide synthetic screen data.
const REVIEW_ONLY_FILES = new Set([
  "unified-dashboard/client/v3/CardHandoffSample.tsx",
  "unified-dashboard/client/v3/CardOrchestrationSettingsSample.tsx",
  "unified-dashboard/client/v3/ComponentsReviewControls.tsx",
  "unified-dashboard/client/v3/ComponentsReviewPage.tsx",
]);
const REMOVED_IDENTIFIERS = [
  "DEFAULT_MODEL_CATALOG", "LIST_PRICES", "MODEL_PRICES", "EXACT_MODEL_ALIASES", "PRICE_SNAPSHOT_METADATA",
];
type Allowance = { file: string; name: string; reason: string };
// The director's sole model-specific operational exception is Fable quota handling. No standalone
// Fable name is currently in the catalog fields checked here, so no entry is needed yet.
const FABLE_LIMIT_ALLOWLIST: Allowance[] = [];
// These occurrences name the Opus audio codec, not a model.
const NON_MODEL_ALLOWLIST: Allowance[] = [
  { file: "orch-server-ts/src/attachments/attachment_read_http.ts", name: "opus", reason: "audio MIME type" },
  { file: "soul-app/src/lib/attachment-view.ts", name: "opus", reason: "audio extension and MIME type" },
];
// 다음 앱 작업에서 모델 이름 없이 고치고 항목을 지운다. App input changes trigger a TestFlight build.
const APP_INPUT_PENDING_ALLOWLIST: Allowance[] = [
  { file: "soul-app/src/api/types.ts", name: "Claude - Opus", reason: "model label example in a comment" },
  { file: "soul-app/src/api/types.ts", name: "opus", reason: "same model label example in a comment" },
];
const ALLOWLIST = [...FABLE_LIMIT_ALLOWLIST, ...NON_MODEL_ALLOWLIST, ...APP_INPUT_PENDING_ALLOWLIST];

function packageSourceDirectories(): string[] {
  const packagesRoot = path.join(REPO_ROOT, "packages");
  return fs.readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => ["src", "generated"].map((subdir) => path.join(packagesRoot, entry.name, subdir)))
    .filter((directory) => fs.existsSync(directory));
}

function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  const normalized = segments.join("/");
  if (EXCLUDED_PATHS.some((excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`))) return true;
  if (REVIEW_ONLY_FILES.has(normalized)) return true;
  const basename = segments.at(-1) ?? "";
  if (/\.(test|spec)\./.test(basename) || basename.endsWith(".example.json")) return true;
  const stem = basename.replace(/\.[^.]+$/, "");
  // Existing review samples and fixture files are synthetic, not production inputs.
  return stem.endsWith("ReviewSample") || stem.includes("fixture");
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (isExcluded(path.relative(REPO_ROOT, absolute))) continue;
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolute);
  }
  return files;
}

function modelNamePattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`, "i");
}

function inspectFile(file: string, text: string, names: string[], allowances: Allowance[]) {
  const matches = names.flatMap((name) => {
    const match = modelNamePattern(name).exec(text);
    return match ? [{ name, index: match.index }] : [];
  }).sort((a, b) => a.index - b.index);
  const allowed = allowances.filter((entry) => entry.file === file);
  return {
    violations: matches.filter(({ name }) => !allowed.some((entry) => entry.name.toLowerCase() === name.toLowerCase()))
      .map(({ name }) => name),
    stale: allowed.filter((entry) => !modelNamePattern(entry.name).test(text)).map((entry) => entry.name),
  };
}

describe("model catalog code tables", () => {
  const catalog = parseModelCatalogYaml(fs.readFileSync(CATALOG_PATH, "utf8"));
  const names = [...new Set([
    ...catalog.presets.flatMap((preset) => [preset.id, preset.label, preset.model]),
    ...catalog.models.flatMap((model) => [model.model, ...(model.aliases ?? []), ...(model.display_name ? [model.display_name] : [])]),
  ])];

  it("reads the canonical catalog", () => {
    expect(catalog.presets.length).toBeGreaterThan(0);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(names.length).toBeGreaterThan(0);
  });

  it("keeps catalog names and removed tables out of production inputs", () => {
    const directories = [...SCAN_DIRECTORIES.map((directory) => path.join(REPO_ROOT, directory)), ...packageSourceDirectories()]
      .filter((directory) => fs.existsSync(directory));
    const files = directories.flatMap(sourceFiles);
    const contents = new Map(files.map((file) => [path.relative(REPO_ROOT, file).split(path.sep).join("/"), fs.readFileSync(file, "utf8")]));
    const failures: string[] = [];
    for (const [file, text] of contents) {
      const result = inspectFile(file, text, names, ALLOWLIST);
      for (const name of result.violations) failures.push(`${file}: model name ${JSON.stringify(name)}`);
      for (const name of result.stale) failures.push(`${file}: stale allowance ${JSON.stringify(name)}`);
      for (const identifier of REMOVED_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(text)) failures.push(`${file}: removed identifier ${identifier}`);
      }
    }
    for (const entry of ALLOWLIST) {
      if (!contents.has(entry.file)) failures.push(`${entry.file}: stale allowance ${JSON.stringify(entry.name)} (file not scanned)`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("model name matching", () => {
  const names = ["opus", "claude-opus", "gpt-6.2-sol"];

  it("finds names case-insensitively in code, comments, and configuration", () => {
    expect(inspectFile("example.ts", `const model = "CLAUDE-OPUS"; // opus\nmodel: gpt-6.2-sol`, names, []).violations)
      .toEqual(["claude-opus", "opus", "gpt-6.2-sol"]);
  });

  it("respects hyphen and dot boundaries", () => {
    expect(inspectFile("example.ts", "claude-opus .opus opus-file opus.name opus", names, []).violations)
      .toEqual(["claude-opus", "opus"]);
    expect(inspectFile("example.ts", "gpt-6x2-sol", names, []).violations).toEqual([]);
  });

  it("allows only the named value in the named file and rejects stale entries", () => {
    const allowances = [{ file: "audio.ts", name: "opus", reason: "audio codec" }];
    expect(inspectFile("audio.ts", "audio/opus claude-opus", names, allowances))
      .toEqual({ violations: ["claude-opus"], stale: [] });
    expect(inspectFile("audio.ts", "audio/wav", names, allowances))
      .toEqual({ violations: [], stale: ["opus"] });
    expect(inspectFile("other.ts", "opus", names, allowances).violations).toEqual(["opus"]);
  });
});
