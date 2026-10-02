import { errorResult, jsonResult, type skillTools } from "@soulstream/mcp-contract";
import { rankByRelevance } from "../relevance/typesafe_client.js";
import { loadSkillCatalog } from "../skills/skill_catalog.js";
import type { McpToolHandler } from "./types.js";

export const skillHandlers = {
  search_skills: async (options, { query, limit }) => {
      const skills = options.skills;
      if (!skills || !skills.logger) return errorResult("skill search is not configured");
      const nodeId = skills.nodeId;
      let catalog;
      try {
        catalog = await loadSkillCatalog({
          nodeId,
          atom: {
            enabled: skills.enabled,
            serverUrl: skills.serverUrl,
            apiKey: skills.apiKey,
          },
          logger: skills.logger,
          httpClient: skills.httpClient,
        });
      } catch {
        return errorResult("Failed to load skill catalog");
      }

      const exact = catalog.find((entry) =>
        entry.name.trim().toLowerCase() === String(query).trim().toLowerCase(),
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

      const apiKey = skills.typesafeApiKey;
      if (!apiKey) return errorResult("TYPESAFE_API_KEY is not configured");

      try {
        const ranked = await rankByRelevance({
          query: String(query),
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
          matches: ranked.slice(0, (limit as number | undefined) ?? 5).flatMap(({ key, score }) => {
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
} satisfies Record<keyof typeof skillTools, McpToolHandler>;
