import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import { registerSkillsToolsLegacy } from "../../src/mcp/tools/skills.js";

const SKILL_NODE_ID = "11111111-2222-4333-8444-555555555555";
const SLACK_BODY_NODE_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const PLANNING_BODY_NODE_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const WRITING_BODY_NODE_ID = "88888888-9999-4aaa-8bbb-cccccccccccc";
const atomMarkdown = `## slack-member-recall <!-- node:11111111-2222-4333-8444-aaaaaaaaaaaa card:66666666-7777-4888-8999-aaaaaaaaaaaa depth:1 -->
description: >
  Slack member lookup and recall.
body_node_id: ${SLACK_BODY_NODE_ID}

## work-plan-execute <!-- node:22222222-3333-4444-8555-bbbbbbbbbbbb card:77777777-8888-4999-8aaa-bbbbbbbbbbbb depth:1 -->
description: >
  Plan and execute coding work.
body_node_id: ${PLANNING_BODY_NODE_ID}

## writing-rhythm <!-- node:33333333-4444-4555-8666-cccccccccccc card:88888888-9999-4aaa-8bbb-cccccccccccc depth:1 -->
description: >
  Write prose with a clear rhythm.
body_node_id: ${WRITING_BODY_NODE_ID}
`;

type SearchSkillsArgs = { query: string; limit?: number };
type SearchSkillsHandler = (args: SearchSkillsArgs) => Promise<CallToolResult>;

function createHarness(): SearchSkillsHandler {
  let handler: SearchSkillsHandler | undefined;
  const server = {
    registerTool: (
      name: string,
      _definition: unknown,
      callback: (args: unknown) => Promise<CallToolResult>,
    ) => {
      if (name === "search_skills") handler = callback as SearchSkillsHandler;
    },
  } as unknown as McpServer;
  registerSkillsToolsLegacy(server, {
    logger: { warn: vi.fn() },
  } as unknown as McpRuntime);
  return handler!;
}

function installFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/compile")) {
      return new Response(JSON.stringify({ markdown: atomMarkdown }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.toString() === "https://api.typesafe.ai/v1/systemone") {
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, unknown>;
      };
      return new Response(JSON.stringify({
        answers: Object.fromEntries(
          Object.keys(body.questions).map((key) => [
            key,
            { type: "score", score: key === "slack-member-recall" ? 3 : 2 },
          ]),
        ),
      }), { status: 200 });
    }
    throw new Error("Unexpected fetch URL");
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("search_skills", () => {
  it("returns an exact name match without calling Typesafe", async () => {
    vi.stubEnv("ATOM_ENABLED", "true");
    vi.stubEnv("ATOM_SERVER_URL", "https://atom.example.test");
    vi.stubEnv("ATOM_API_KEY", "atom-test-key");
    vi.stubEnv("SKILL_CATALOG_NODE_ID", SKILL_NODE_ID);
    vi.stubEnv("TYPESAFE_API_KEY", "typesafe-test-key");
    const fetchMock = installFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createHarness();

    const result = await handler({ query: " Slack-Member-Recall " });

    expect(result.structuredContent).toEqual({
      mode: "exact",
      query: " Slack-Member-Recall ",
      matches: [{
        name: "slack-member-recall",
        description: "Slack member lookup and recall.\n",
        body_node_id: SLACK_BODY_NODE_ID,
        score: 1,
      }],
    });
    expect(fetchMock.mock.calls.filter(([input]) =>
      input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(0);
  });

  it("ranks candidates and respects the requested limit", async () => {
    vi.stubEnv("ATOM_ENABLED", "true");
    vi.stubEnv("ATOM_SERVER_URL", "https://atom.example.test");
    vi.stubEnv("ATOM_API_KEY", "atom-test-key");
    vi.stubEnv("SKILL_CATALOG_NODE_ID", "99999999-aaaa-4bbb-8ccc-dddddddddddd");
    vi.stubEnv("TYPESAFE_API_KEY", "typesafe-test-key");
    const fetchMock = installFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createHarness();

    const result = await handler({ query: "help with a Slack member request", limit: 2 });

    expect(result.structuredContent).toMatchObject({
      mode: "ranked",
      query: "help with a Slack member request",
      matches: [
        { name: "slack-member-recall", score: 1 },
        { name: "work-plan-execute", score: 2 / 3 },
      ],
    });
    expect((result.structuredContent as { matches: unknown[] }).matches).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([input]) =>
      input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(1);
  });

  it("returns the configured error when Typesafe key is missing", async () => {
    vi.stubEnv("ATOM_ENABLED", "true");
    vi.stubEnv("ATOM_SERVER_URL", "https://atom.example.test");
    vi.stubEnv("ATOM_API_KEY", "atom-test-key");
    vi.stubEnv("SKILL_CATALOG_NODE_ID", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetchMock = installFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const handler = createHarness();

    const result = await handler({ query: "help with an unrelated request" });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({ type: "text", text: "TYPESAFE_API_KEY is not configured" });
    expect(fetchMock.mock.calls.filter(([input]) =>
      input.toString() === "https://api.typesafe.ai/v1/systemone")).toHaveLength(0);
  });
});
