import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const retiredSurfaceRoots = [
  "soul-server-ts/src",
  "orch-server-ts/src",
  "orch-server/src",
  "packages/soul-common/src",
  "packages/wire-schema/src",
  "packages/wire-schema/generated",
  "unified-dashboard/client",
  ".env.soul-server-ts.example",
];

function listFiles(relativePath: string): string[] {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const stats = lstatSync(absolutePath);
  if (stats.isFile()) return [relativePath];
  if (!stats.isDirectory()) return [];

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = path.join(relativePath, entry.name);
    if (entry.isDirectory()) return listFiles(childPath);
    return entry.isFile() ? [childPath] : [];
  });
}

function findSupervisorMatches(relativePath: string): string[] {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) =>
      /supervisor/i.test(line) ? [`${relativePath}:${index + 1}:${line}`] : [],
    );
}

describe("retired runtime surface", () => {
  it("contains no supervisor subsystem identifiers", () => {
    const forbiddenMatches = retiredSurfaceRoots
      .flatMap(listFiles)
      .flatMap(findSupervisorMatches)
      .filter((line) => !line.endsWith('migrationId: "053_retire_supervisor.sql",'));
    expect(forbiddenMatches).toEqual([]);
  });
});
