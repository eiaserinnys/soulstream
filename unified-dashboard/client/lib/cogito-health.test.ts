import { describe, expect, it } from "vitest";
import { summarizeCogitoHealth } from "./cogito-health";

describe("summarizeCogitoHealth", () => {
  it("extracts safe node health from the brief snapshot services wrapper", () => {
    const summary = summarizeCogitoHealth({
      status: "ok",
      checked_at: "2026-05-25T12:00:00.000Z",
      node_count: 1,
      nodes: [
        {
          node_id: "node-a",
          status: "ok",
          checked_at: "2026-05-25T12:00:01.000Z",
          data: {
            status: "partial",
            services: [
              {
                name: "soul-server-ts",
                data: {
                  service: "soul-server-ts",
                  status: "partial",
                  capabilities: [
                    { name: "cogito" },
                    { name: "session_query" },
                    { name: "catalog" },
                    { name: "agent_config" },
                    { name: "multi_node" },
                    { name: "session_mgmt" },
                    { name: "extra" },
                  ],
                  aggregate_sources: {
                    orchestrator: {
                      base_url: "https://secret.example.internal",
                    },
                  },
                  sections: {
                    runtime: {
                      status: "partial",
                      data: {
                        process: {
                          pid: 12345,
                          cwd: "/home/eias/services/soulstream",
                          exec_path: "/usr/local/bin/node",
                          uptime_seconds: 3661,
                          memory: {
                            rss: 157_286_400,
                            heap_used: 52_428_800,
                          },
                        },
                        counts: {
                          agent_count: 6,
                          active_task_count: 3,
                          tasks_by_status: { running: 2, completed: 1 },
                        },
                        dependency_statuses: {
                          database: "ok",
                          orchestrator: "unavailable",
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
          errors: [],
        },
      ],
    });

    expect(summary.status).toBe("ok");
    expect(summary.nodes[0]).toMatchObject({
      nodeId: "node-a",
      status: "ok",
      service: "soul-server-ts",
      serviceStatus: "partial",
      capabilityCount: 7,
      capabilities: [
        "cogito",
        "session_query",
        "catalog",
        "agent_config",
        "multi_node",
        "session_mgmt",
      ],
      omittedCapabilities: 1,
      runtime: {
        status: "partial",
        uptimeLabel: "1h 1m",
        memoryLabel: "rss 150MB / heap 50MB",
        agentCount: 6,
        activeTaskCount: 3,
        tasksByStatus: { running: 2, completed: 1 },
        dependencies: [
          { name: "database", status: "ok" },
          { name: "orchestrator", status: "unavailable" },
        ],
      },
    });
    const renderedPayload = JSON.stringify(summary);
    expect(renderedPayload).not.toContain("/home/eias");
    expect(renderedPayload).not.toContain("/usr/local/bin/node");
    expect(renderedPayload).not.toContain("secret.example");
    expect(renderedPayload).not.toContain("12345");
  });

  it("keeps node failure states and sanitizes warning messages", () => {
    const summary = summarizeCogitoHealth({
      status: "error",
      checked_at: "2026-05-25T12:00:00.000Z",
      node_count: 3,
      nodes: [
        {
          node_id: "node-timeout",
          status: "timeout",
          errors: [
            {
              code: "node_timeout",
              message:
                "timeout with Bearer secret-token at /home/eias/services/soulstream/server.js",
            },
          ],
        },
        { node_id: "node-unavailable", status: "unavailable" },
        { node_id: "node-error", status: "error" },
      ],
    });

    expect(summary.nodes.map((node) => node.status)).toEqual([
      "timeout",
      "unavailable",
      "error",
    ]);
    expect(summary.nodes[0].warnings[0]).toEqual({
      code: "node_timeout",
      message: "timeout with Bearer [redacted] at [path]",
    });
  });

  it("preserves empty aggregate state", () => {
    const summary = summarizeCogitoHealth({
      status: "empty",
      checked_at: "2026-05-25T12:00:00.000Z",
      node_count: 0,
      nodes: [],
    });

    expect(summary).toMatchObject({
      status: "empty",
      nodeCount: 0,
      nodes: [],
    });
  });
});
