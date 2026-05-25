/**
 * reflect_* 도구 — TS 노드의 *자기 자신* 리플렉션.
 *
 * Python `mcp_cogito.py` 정합 — 단 TS 노드는 manifest를 별도로 보유하지 않으므로
 * 도구는 *현 프로세스의 capability/source 위치*만 반환한다.
 * 외부 서비스(다른 노드, slack 봇 등) 리플렉션은 본 카드 범위 외.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import {
  buildBriefSnapshot,
  reflectSelf,
  SELF_IDENTITY,
  type ReflectionLevel,
} from "../reflection/self_reflection.js";

export function registerReflectTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "reflect_service",
    {
      description:
        "서비스의 리플렉션 데이터를 조회한다. 본 TS 노드는 'soul-server-ts'만 반영하며 그 외 서비스는 {error, available}을 반환.",
      inputSchema: {
        service: z.string().describe("서비스 이름"),
        level: z
          .number()
          .int()
          .min(0)
          .max(3)
          .default(0)
          .describe("0=기능, 1=설정, 2=소스, 3=런타임"),
        capability: z
          .string()
          .optional()
          .describe("특정 capability만 조회 (선택)"),
      },
    },
    async ({ service, level, capability }) => {
      if (service !== SELF_IDENTITY.name) {
        return errorResult(
          `서비스를 찾을 수 없습니다: ${service}. 본 노드는 '${SELF_IDENTITY.name}'만 반영합니다.`,
        );
      }
      const lv = (level ?? 0) as ReflectionLevel;
      const reflection = await reflectSelf(runtime, lv, capability);
      return jsonResult(reflection);
    },
  );

  server.registerTool(
    "reflect_brief",
    {
      description:
        "본 TS 노드의 Level 0 브리프를 반환한다. 파일은 생성하지 않는다.",
      inputSchema: {},
    },
    async () => {
      return jsonResult(await buildBriefSnapshot(runtime));
    },
  );

  server.registerTool(
    "reflect_refresh",
    {
      description:
        "Cogito brief 파일 영속화는 제거되었다. 호환용 no-op.",
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        refreshed: false,
        reason: "cogito brief files are no longer persisted",
      });
    },
  );
}
