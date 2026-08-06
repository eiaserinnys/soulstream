import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = fileURLToPath(new URL("../../src", import.meta.url));
const DIRECT_READ_PATTERN = /\b(?:FROM|JOIN)\s+(?:sessions|events|session_digests)\b|\b(?:session_get|session_list_summary|event_count|event_read|event_read_one|event_stream_raw|event_search|session_id_search)\s*\(/gi;
const DIRECT_SQL_PATTERN = /\b(?:this\.)?sql(?:<[^`]+>)?\s*`/g;

describe("worker session-data read boundary", () => {
  it("keeps every direct session, event, and story read out of worker code", () => {
    const matches = new Map<string, number>();
    for (const file of walkTypescriptFiles(SOURCE_ROOT)) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(DIRECT_READ_PATTERN)) {
        const key = `${relative(SOURCE_ROOT, file)}::${match[0].toLowerCase()}`;
        matches.set(key, (matches.get(key) ?? 0) + 1);
      }
    }

    expect(Object.fromEntries([...matches].sort())).toEqual({});
  });

  it("keeps every direct SQL module inside the Phase 12 inventory", () => {
    const matches = new Set<string>();
    for (const file of walkTypescriptFiles(SOURCE_ROOT)) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (DIRECT_SQL_PATTERN.test(source)) matches.add(relative(SOURCE_ROOT, file));
      DIRECT_SQL_PATTERN.lastIndex = 0;
    }

    expect([...matches].sort()).toEqual([
      "db/repositories/session_repository.ts",
      "db/runtime_schema_preflight.ts",
      "db/session_db.ts",
    ]);
  });
});

function walkTypescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return walkTypescriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
