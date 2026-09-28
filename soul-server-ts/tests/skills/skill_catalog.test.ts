import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadSkillCatalog,
  parseSkillCatalogMarkdown,
} from "../../src/skills/skill_catalog.js";

const VALID_NODE_ID = "11111111-2222-4333-8444-555555555555";
const VALID_BODY_NODE_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const markdown = `## multi-line-skill <!-- node:${VALID_NODE_ID} card:66666666-7777-4888-8999-bbbbbbbbbbbb depth:1 -->
description: >
  First line of the description.
  Second line of the description.
body_node_id: ${VALID_BODY_NODE_ID}
notes: Optional note.

## missing-body-node <!-- node:77777777-8888-4999-8aaa-bbbbbbbbbbbb card:66666666-7777-4888-8999-cccccccccccc depth:1 -->
description: This entry must be skipped.

## invalid-body-node <!-- node:99999999-aaaa-4bbb-8ccc-dddddddddddd card:66666666-7777-4888-8999-eeeeeeeeeeee depth:1 -->
description: This entry must also be skipped.
body_node_id: not-a-uuid
`;

const logger = { warn: vi.fn() };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("parseSkillCatalogMarkdown", () => {
  it("parses folded descriptions and skips entries without a valid body node id", () => {
    const result = parseSkillCatalogMarkdown(markdown, logger);

    expect(result).toEqual([{
      name: "multi-line-skill",
      description: "First line of the description. Second line of the description.\n",
      bodyNodeId: VALID_BODY_NODE_ID,
      notes: "Optional note.",
    }]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe("loadSkillCatalog", () => {
  it("caches only successful loads for 60 seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("upstream error", { status: 503 }))
      .mockImplementation(async () => new Response(JSON.stringify({ markdown }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    globalThis.fetch = fetchMock;

    const config = {
      nodeId: VALID_NODE_ID,
      atom: {
        enabled: true,
        serverUrl: "https://atom.example.test",
        apiKey: "atom-test-key",
      },
      logger,
    };

    await expect(loadSkillCatalog(config)).rejects.toThrow("Failed to fetch skill catalog");
    const first = await loadSkillCatalog(config);
    await loadSkillCatalog(config);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await loadSkillCatalog(config);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
