import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardYjsHostClient } from "../../src/collaboration/board_yjs_host_client.js";

function createSilentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => createSilentLogger(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("board Yjs orchestrator delegation", () => {
  it("worker source has no node-host mode or direct board persistence writer", () => {
    const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));
    const forbidden = [
      /BOARD_YJS_HOST_NODE_ID/,
      /BOARD_YJS_HOST_MODE/,
      /isBoardYjsHostNode/,
      /boardYjsHostMode/,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:board_yjs_documents|board_yjs_updates|board_items|markdown_documents)\b/,
    ];
    const violations = collectTypeScriptFiles(sourceRoot).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return forbidden
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${filePath.slice(sourceRoot.length + 1)}: ${pattern.source}`);
    });

    expect(violations).toEqual([]);
  });

  it("worker mutations are sent to the orchestrator host operation route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new BoardYjsHostClient({
      orch: {
        baseUrl: "http://orch.local",
        headers: { authorization: "Bearer test-token" },
      },
      logger: createSilentLogger() as never,
    });

    await client.updateBoardItemPosition(
      { containerKind: "task", containerId: "task-1" },
      "markdown:doc-1",
      120,
      240,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://orch.local/api/board-yjs/host/update-board-item-position");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer test-token",
      "content-type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      container: { containerKind: "task", containerId: "task-1" },
      boardItemId: "markdown:doc-1",
      x: 120,
      y: 240,
    });
  });
});

function collectTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(filePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [filePath] : [];
  });
}
