import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sourceRoots = [
  { root: fileURLToPath(new URL("../src", import.meta.url)), prefix: "orch-server-ts/src/" },
  { root: fileURLToPath(new URL("../../soul-server-ts/src", import.meta.url)), prefix: "soul-server-ts/src/" },
];

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("node credential composition contract", () => {
  it("never hard-codes a null node credential resolver in production source", () => {
    const offenders = sourceRoots.flatMap(({ root, prefix }) =>
      collectTypeScriptFiles(root)
        .filter((file) => readFileSync(file, "utf8").includes("nodeCredentials: null"))
        .map((file) => prefix + file.slice(root.length + 1)),
    );

    expect(offenders).toEqual([]);
  });
});
