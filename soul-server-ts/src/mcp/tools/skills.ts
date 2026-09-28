import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { rankByRelevance } from "../../relevance/typesafe_client.js";
import {
  DEFAULT_SKILL_CATALOG_NODE_ID,
  loadSkillCatalog,
} from "../../skills/skill_catalog.js";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerSkillsTools(server: McpServer, runtime: McpRuntime): void {
  server.registerTool(
    "search_skills",
    {
      description:
        "스킬 카탈로그에서 요청에 맞는 스킬을 적합도 순으로 찾는다. 주입된 카탈로그에 없는 절차성 요청일 때 body_node_id를 얻기 위해 쓴다.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(10).default(5),
      },
    },
    async ({ query, limit }) => {
      const nodeId = process.env.SKILL_CATALOG_NODE_ID ?? DEFAULT_SKILL_CATALOG_NODE_ID;
      let catalog;
      try {
        catalog = await loadSkillCatalog({
          nodeId,
          atom: {
            enabled: process.env.ATOM_ENABLED === "true",
            serverUrl: process.env.ATOM_SERVER_URL ?? "",
            apiKey: process.env.ATOM_API_KEY ?? "",
          },
          logger: runtime.logger,
        });
      } catch {
        return errorResult("Failed to load skill catalog");
      }

      const exact = catalog.find((entry) =>
        entry.name.trim().toLowerCase() === query.trim().toLowerCase(),
      );
      if (exact) {
        return jsonResult({
          mode: "exact",
          query,
          matches: [{
            name: exact.name,
            description: exact.description,
            body_node_id: exact.bodyNodeId,
            score: 1,
          }],
        });
      }

      const apiKey = process.env.TYPESAFE_API_KEY;
      if (!apiKey) return errorResult("TYPESAFE_API_KEY is not configured");

      try {
        const ranked = await rankByRelevance({
          query,
          items: catalog.map((entry) => ({
            key: entry.name,
            text: `${entry.name}: ${entry.description}`,
          })),
          apiKey,
        });
        const entryByName = new Map(catalog.map((entry) => [entry.name, entry]));
        return jsonResult({
          mode: "ranked",
          query,
          matches: ranked.slice(0, limit ?? 5).flatMap(({ key, score }) => {
            const entry = entryByName.get(key);
            return entry ? [{
              name: entry.name,
              description: entry.description,
              body_node_id: entry.bodyNodeId,
              score,
            }] : [];
          }),
        });
      } catch {
        return errorResult("Skill search failed");
      }
    },
  );
}
