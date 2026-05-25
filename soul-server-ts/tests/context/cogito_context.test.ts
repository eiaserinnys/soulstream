import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchCogitoContextItem,
  type CogitoContextConfig,
} from "../../src/context/cogito_context.js";

const silentLogger = pino({ level: "silent" });

function makeConfig(overrides: Partial<CogitoContextConfig> = {}): CogitoContextConfig {
  return {
    baseUrl: "https://orch.test",
    headers: { authorization: "Bearer secret-token" },
    timeoutMs: 50,
    maxNodes: 4,
    maxChars: 4000,
    ...overrides,
  };
}

function makeAggregate() {
  return {
    schema_version: "soulstream.reflect.aggregate.v1",
    kind: "orchestrator_node_brief_aggregate",
    status: "partial",
    checked_at: "2026-05-25T12:00:00.000Z",
    node_count: 2,
    aggregate_sources: {
      orchestrator: {
        base_url: "https://secret-orch.internal",
      },
    },
    nodes: [
      {
        node_id: "node-a",
        status: "ok",
        checked_at: "2026-05-25T12:00:01.000Z",
        data: {
          service: "soul-server-ts",
          status: "ok",
          capabilities: [
            { name: "cogito" },
            { name: "session_mgmt" },
            { name: "multi_node" },
          ],
          sections: {
            runtime: {
              status: "ok",
              checked_at: "2026-05-25T12:00:01.000Z",
              data: {
                process: {
                  pid: 1234,
                  cwd: "/srv/credential-path",
                  exec_path: "/usr/local/bin/node",
                  argv: ["node", "--token=raw-secret"],
                  cmdline: "node app --secret raw-secret",
                  env: { SECRET_TOKEN: "raw-secret" },
                  uptime_seconds: 32,
                  memory: {
                    rss: 1000,
                    heap_used: 200,
                  },
                },
                counts: {
                  agent_count: 6,
                  active_task_count: 2,
                  tasks_by_status: { running: 2 },
                },
                dependencies: {
                  database: {
                    status: "ok",
                    url: "postgres://raw-secret@db/soulstream",
                  },
                  orchestrator: {
                    status: "unavailable",
                    base_url: "https://secret-orch.internal",
                  },
                },
              },
            },
          },
          aggregate_sources: {
            orchestrator: {
              base_url: "https://secret-orch.internal",
            },
          },
        },
      },
      {
        node_id: "node-b",
        status: "timeout",
        errors: [
          {
            code: "reflect_brief_timeout",
            message: "reflect_brief command timed out",
            detail: { token: "raw-secret" },
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchCogitoContextItem", () => {
  it("builds a compact allowlisted context and drops raw runtime secrets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeAggregate()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const item = await fetchCogitoContextItem(makeConfig(), silentLogger);

    expect(item.key).toBe("cogito_context");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://orch.test/cogito/briefs",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer secret-token" }),
      }),
    );

    const content = item.content as Record<string, unknown>;
    expect(content.status).toBe("partial");
    expect(content.nodes).toEqual([
      expect.objectContaining({
        node_id: "node-a",
        status: "ok",
        service_status: "ok",
        capabilities: ["cogito", "session_mgmt", "multi_node"],
        runtime: expect.objectContaining({
          status: "ok",
          uptime_seconds: 32,
          memory: { rss: 1000, heap_used: 200 },
          counts: {
            agent_count: 6,
            active_task_count: 2,
            tasks_by_status: { running: 2 },
          },
          dependency_statuses: {
            database: "ok",
            orchestrator: "unavailable",
          },
        }),
      }),
      expect.objectContaining({
        node_id: "node-b",
        status: "timeout",
        warnings: [
          { code: "reflect_brief_timeout", message: "reflect_brief command timed out" },
        ],
      }),
    ]);

    const serialized = JSON.stringify(content);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("raw-secret");
    expect(serialized).not.toContain("/srv/credential-path");
    expect(serialized).not.toContain("/usr/local/bin/node");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("base_url");
    expect(serialized).not.toContain("argv");
    expect(serialized).not.toContain("cmdline");
    expect(serialized).not.toContain("SECRET_TOKEN");
  });

  it("turns fetch failure into an unavailable warning context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("raw-secret network down")));

    const item = await fetchCogitoContextItem(makeConfig(), silentLogger);

    const content = item.content as Record<string, unknown>;
    expect(content.status).toBe("unavailable");
    expect(content.warnings).toEqual([
      {
        code: "cogito_context_unavailable",
        message: "cogito cluster brief unavailable; startup continues without live cluster context",
      },
    ]);
    expect(JSON.stringify(content)).not.toContain("raw-secret");
  });

  it("aborts slow aggregate lookup at the configured timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchCogitoContextItem(
      makeConfig({ timeoutMs: 5 }),
      silentLogger,
    );
    await vi.advanceTimersByTimeAsync(6);
    const item = await pending;

    const content = item.content as Record<string, unknown>;
    expect(content.status).toBe("unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps node count and records omitted nodes", async () => {
    const aggregate = {
      ...makeAggregate(),
      status: "ok",
      node_count: 5,
      nodes: Array.from({ length: 5 }, (_, idx) => ({
        node_id: `node-${idx}`,
        status: "ok",
        data: {
          service: "soul-server-ts",
          status: "ok",
          capabilities: Array.from({ length: 20 }, (_v, capIdx) => ({
            name: `capability-${capIdx}`,
          })),
        },
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(aggregate), { status: 200 }),
      ),
    );

    const item = await fetchCogitoContextItem(
      makeConfig({ maxNodes: 2, maxChars: 5000 }),
      silentLogger,
    );

    const content = item.content as {
      source: { omitted_nodes: number };
      nodes: Array<{ capabilities: string[]; omitted_capabilities: number }>;
      warnings: Array<{ code: string }>;
    };
    expect(content.nodes).toHaveLength(2);
    expect(content.source.omitted_nodes).toBe(3);
    expect(content.nodes[0]?.capabilities).toHaveLength(12);
    expect(content.nodes[0]?.omitted_capabilities).toBe(8);
    expect(content.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cogito_context_truncated" }),
      ]),
    );
  });

  it("caps serialized context size by omitting node details", async () => {
    const aggregate = {
      ...makeAggregate(),
      status: "ok",
      node_count: 5,
      nodes: Array.from({ length: 5 }, (_, idx) => ({
        node_id: `node-${idx}`,
        status: "ok",
        data: {
          service: "soul-server-ts",
          status: "ok",
          capabilities: Array.from({ length: 20 }, (_v, capIdx) => ({
            name: `capability-${idx}-${capIdx}`,
          })),
        },
      })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(aggregate), { status: 200 }),
      ),
    );

    const item = await fetchCogitoContextItem(
      makeConfig({ maxNodes: 5, maxChars: 900 }),
      silentLogger,
    );

    const content = item.content as {
      nodes: Array<unknown>;
      warnings: Array<{ code: string }>;
    };
    expect(content.nodes.length).toBeLessThan(5);
    expect(content.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cogito_context_truncated" }),
      ]),
    );
    expect(JSON.stringify(content, null, 2).length).toBeLessThanOrEqual(900);
  });
});
