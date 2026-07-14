import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_PATH = fileURLToPath(new URL("./useNodes.ts", import.meta.url));

describe("useNodes source policy", () => {
  it("uses the SSE snapshot as the single initial node source", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");

    expect(source).toContain('new EventSource("/api/nodes/stream")');
    expect(source).toContain('addEventListener("snapshot"');
    expect(source).not.toContain('fetch("/api/nodes")');
  });
});
