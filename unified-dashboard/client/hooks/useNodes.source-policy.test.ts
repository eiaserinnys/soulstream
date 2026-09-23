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

  it("marks node state ready only after the first snapshot, not when the socket opens", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    const onOpen = source.match(/connection\.onopen = \(\) => \{([\s\S]*?)\n      \};/)?.[1] ?? "";
    const snapshot = source.match(/addEventListener\("snapshot", \(e\) => \{([\s\S]*?)\n      \}\);/)?.[1] ?? "";

    expect(onOpen).not.toContain('setConnectionStatus("connected")');
    expect(snapshot).toContain('setConnectionStatus("connected")');
  });

  it("ignores named server error messages when checking stream authentication", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    const onError = source.match(/connection\.onerror = \((.*?)\) => \{([\s\S]*?)\n      \};/);
    expect(onError).not.toBeNull();
    expect(onError?.[2]).toContain(`${onError?.[1]} instanceof MessageEvent`);
  });
});
