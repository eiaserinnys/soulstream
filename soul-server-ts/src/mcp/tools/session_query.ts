import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { SessionQueryConsumptionBoundary } from "./session_query_consumption_boundary.js";
export { registerSessionQueryToolsLegacy } from "./session_query_legacy.js";
const DEFAULT_DOWNLOAD_DIR = "/tmp/soulstream_sessions";
export function registerSessionQueryTools(server: McpServer, runtime: McpRuntime): void {
  const consumptionBoundary = new SessionQueryConsumptionBoundary(runtime.childCompletionConsumption);
  registerOrchestratorTools(server, runtime, [sessionTools.get_session_turn_summaries]);
  registerOrchestratorTools(server, runtime, [sessionTools.list_sessions]);
  registerOrchestratorTools(server, runtime, [sessionTools.list_session_events]);
  registerOrchestratorTools(server, runtime, [sessionTools.get_session_event]);
  registerOrchestratorTools(server, runtime, [sessionTools.get_session_story]);
  registerOrchestratorTools(server, runtime, [sessionTools.get_session_highlight]);
  server.registerTool(
    "download_session_history",
    {
      description:
        "세션의 전체 이벤트 히스토리를 JSONL 파일로 저장. default dir /tmp/soulstream_sessions/.",
      inputSchema: {
        session_id: z.string(),
        output_dir: z.string().optional(),
      },
    },
    async ({ session_id, output_dir }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      const outDir = output_dir ?? DEFAULT_DOWNLOAD_DIR;
      mkdirSync(outDir, { recursive: true });
      const filePath = join(outDir, `session_${session_id}.jsonl`);
      const rows = await runtime.db.streamEventsRaw(session_id);
      const lines = rows
        .map((r) => {
          let parsedPayload: unknown = {};
          try {
            parsedPayload = JSON.parse(r.payload_text);
          } catch {
            parsedPayload = {};
          }
          return JSON.stringify({
            id: r.id,
            event_type: r.event_type,
            event: parsedPayload,
          });
        })
        .join("\n");
      writeFileSync(
        filePath,
        lines.length > 0 ? `${lines}\n` : "",
        "utf-8",
      );
      const result = jsonResult({
        session_id,
        file_path: filePath,
        event_count: rows.length,
      });
      return consumptionBoundary.commit(
        "download_session_history",
        result,
        [{
          session,
          reflectedRevision: rows[rows.length - 1]?.id ?? null,
        }],
      );
    },
  );
  registerOrchestratorTools(server, runtime, [sessionTools.search_session_history]);
  registerOrchestratorTools(server, runtime, [sessionTools.search_sessions]);
  registerOrchestratorTools(server, runtime, [sessionTools.get_session_summary]);
}
