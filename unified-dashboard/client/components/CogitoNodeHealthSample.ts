import type { CogitoBriefAggregate } from "../lib/cogito-health";

/**
 * 검수 창에서 쓰는 운영 모양 /cogito/briefs 응답.
 * summarizeCogitoHealth가 읽는 sections.identity(기능)와 sections.runtime(실행 상태·의존 서비스)을 그대로 담는다.
 */
const SAMPLE_CHECKED_AT = "2026-11-13T09:15:00+09:00";

export interface SampleCogitoNodeOptions {
  status?: "ok" | "timeout" | "unavailable" | "error";
  warnings?: Array<{ code: string; message: string }>;
}

function sampleCogitoNode(
  nodeId: string,
  options: SampleCogitoNodeOptions,
): Record<string, unknown> {
  const status = options.status ?? "ok";
  return {
    node_id: nodeId,
    status,
    checked_at: SAMPLE_CHECKED_AT,
    data: {
      service: "soul-server-ts",
      status,
      sections: {
        identity: {
          status: "ok",
          data: {
            capabilities: ["cogito", "session_query", "card_query", "node_registry"],
          },
        },
        runtime: {
          status: status === "ok" ? "ok" : "unavailable",
          data: {
            process: {
              uptime_seconds: 2 * 60 * 60 + 13 * 60,
              memory: { rss: 264 * 1024 * 1024, heap_used: 82 * 1024 * 1024 },
            },
            counts: {
              agent_count: 4,
              active_task_count: 1,
              tasks_by_status: { running: 1 },
            },
            dependencies: {
              database: { status: "ok" },
              redis: { status: "ok" },
            },
          },
        },
      },
    },
    errors: options.warnings ?? [],
  };
}

export function sampleCogitoBriefs(
  nodes: Array<{ nodeId: string } & SampleCogitoNodeOptions>,
): CogitoBriefAggregate {
  return {
    schema_version: "1",
    kind: "cogito_brief",
    status: nodes.some((node) => (node.status ?? "ok") !== "ok") ? "partial" : "ok",
    checked_at: SAMPLE_CHECKED_AT,
    node_count: nodes.length,
    nodes: nodes.map(({ nodeId, ...options }) => sampleCogitoNode(nodeId, options)),
  };
}
