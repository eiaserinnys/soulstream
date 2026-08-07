import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ORCH_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("board Y.Doc snapshot canonical contract", () => {
  it("keeps board_yjs_updates exclusive to page persistence", () => {
    const consumers = ["src", "scripts"]
      .flatMap((directory) => listTypeScriptFiles(resolve(ORCH_ROOT, directory)))
      .filter((path) => readFileSync(path, "utf8").includes("board_yjs_updates"))
      .map((path) => relative(ORCH_ROOT, path))
      .sort();

    expect(consumers).toEqual(["src/page/page_repository.ts"]);
    expect(readFileSync(resolve(ORCH_ROOT, consumers[0]!), "utf8"))
      .toContain("INSERT INTO board_yjs_updates");
  });
});

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}
