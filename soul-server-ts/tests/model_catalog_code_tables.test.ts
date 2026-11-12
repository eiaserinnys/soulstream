/**
 * 코드 속 프리셋 표·단가표·이름표의 재등장을 막는 좁은 계약 시험.
 * 정본은 packages/model-catalog/data/model-catalog.yaml 하나이며, 운영 코드는
 * 그 파일을 읽어 쓰고 자기 사본을 두지 않는다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseModelCatalogYaml } from "@soulstream/model-catalog";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_PATH = path.join(REPO_ROOT, "packages", "model-catalog", "data", "model-catalog.yaml");

const SCAN_DIRECTORIES = [
  "soul-server-ts/src",
  "orch-server-ts/src",
  "unified-dashboard/client",
  "soul-app/src",
];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];
const EXCLUDED_SEGMENTS = new Set(["tests", "__tests__", "fixtures", "component-review"]);
const REMOVED_IDENTIFIERS = [
  "DEFAULT_MODEL_CATALOG",
  "LIST_PRICES",
  "MODEL_PRICES",
  "EXACT_MODEL_ALIASES",
  "PRICE_SNAPSHOT_METADATA",
];
const MAX_ALLOWED_PRESET_LITERALS = 2;

function packageSourceDirectories(): string[] {
  const packagesRoot = path.join(REPO_ROOT, "packages");
  return fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(packagesRoot, entry.name, "src"))
    .filter((directory) => fs.existsSync(directory));
}

function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split(path.sep);
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  const basename = segments[segments.length - 1] ?? "";
  if (/\.(test|spec)\./.test(basename)) return true;
  const stem = basename.replace(/\.[^.]+$/, "");
  // Synthetic sample data for tests and review screens (usage-stats-fixtures,
  // usage-stats-fixture-data, ...) may carry display names on purpose.
  return stem.endsWith("ReviewSample") || stem.includes("fixture");
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.includes(path.extname(entry.name))) continue;
    const relative = path.relative(REPO_ROOT, absolute);
    if (!isExcluded(relative)) files.push(absolute);
  }
  return files;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 큰따옴표·작은따옴표·템플릿 리터럴로 감싼 정확한 문자열 리터럴만 센다. */
function hasQuotedLiteral(text: string, value: string): boolean {
  return new RegExp(`["'\`]${escapeForRegExp(value)}["'\`]`).test(text);
}

describe("model catalog code tables", () => {
  const catalog = parseModelCatalogYaml(fs.readFileSync(CATALOG_PATH, "utf8"));
  const presetIds = catalog.presets.map((preset) => preset.id);
  const displayNames = catalog.models
    .map((model) => model.display_name)
    .filter((name): name is string => typeof name === "string");

  it("reads the canonical catalog", () => {
    expect(presetIds.length).toBeGreaterThan(0);
    expect(displayNames.length).toBeGreaterThan(0);
  });

  it("keeps preset tables, price tables, and display names out of production code", () => {
    const directories = [...SCAN_DIRECTORIES, ...packageSourceDirectories()]
      .map((directory) => path.resolve(REPO_ROOT, directory))
      .filter((directory) => fs.existsSync(directory));
    const failures: string[] = [];

    for (const file of directories.flatMap((directory) => sourceFiles(directory))) {
      const relative = path.relative(REPO_ROOT, file);
      const text = fs.readFileSync(file, "utf8");

      const presetLiterals = presetIds.filter((presetId) => hasQuotedLiteral(text, presetId));
      if (presetLiterals.length > MAX_ALLOWED_PRESET_LITERALS) {
        failures.push(
          `${relative}: 프리셋 id 문자열 리터럴 ${presetLiterals.length}개 (${presetLiterals.join(", ")})`,
        );
      }

      for (const identifier of REMOVED_IDENTIFIERS) {
        if (new RegExp(`\\b${identifier}\\b`).test(text)) {
          failures.push(`${relative}: 제거된 식별자 ${identifier}`);
        }
      }

      for (const displayName of displayNames) {
        if (hasQuotedLiteral(text, displayName)) {
          failures.push(`${relative}: 정본 표시 이름 "${displayName}"`);
        }
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
