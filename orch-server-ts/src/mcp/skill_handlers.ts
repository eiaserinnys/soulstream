import { errorResult, jsonResult, type skillTools } from "@soulstream/mcp-contract";
import { rankByRelevance } from "../relevance/typesafe_client.js";
import {
  DEFAULT_DOMAIN_CATALOG_NODE_ID,
  type DomainCatalogEntry,
  loadDomainCatalog,
  loadSkillCatalog,
  rankAndComposeCatalogs,
} from "../skills/skill_catalog.js";
import type { McpToolHandler } from "./types.js";

function catalogEvaluationText(catalog: DomainCatalogEntry): string {
  return [
    `${catalog.name}: ${catalog.description}`,
    catalog.aliases?.length ? `Aliases: ${catalog.aliases.join(", ")}` : undefined,
    `Axes: ${catalog.axis.join(", ")}`,
    `Composition: ${catalog.composition}`,
    catalog.appliesTo?.media?.length ? `Media: ${catalog.appliesTo.media.join(", ")}` : undefined,
    catalog.appliesTo?.operations?.length ? `Operations: ${catalog.appliesTo.operations.join(", ")}` : undefined,
    catalog.providesInput?.length ? `Inputs: ${catalog.providesInput.join(", ")}` : undefined,
    catalog.sampleCues?.length ? `Cues: ${catalog.sampleCues.join("; ")}` : undefined,
    catalog.shards?.length ? `Shards: ${catalog.shards.map(shard => `${shard.name}: ${(shard.cues ?? []).join(", ")}`).join("; ")}` : undefined,
    catalog.bindings?.length ? `Bindings: ${catalog.bindings.map(binding => `${binding.targetCatalog} (${binding.targetAxis})`).join("; ")}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

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
  match_skill_catalogs: async (options, { intent, skill_name, limit }) => {
    const skills = options.skills;
    if (!skills || !skills.logger) return errorResult("skill catalog matching is not configured");

    let catalogs;
    try {
      catalogs = await loadDomainCatalog({
        nodeId: skills.catalogsNodeId ?? DEFAULT_DOMAIN_CATALOG_NODE_ID,
        atom: {
          enabled: skills.enabled,
          serverUrl: skills.serverUrl,
          apiKey: skills.apiKey,
        },
        logger: skills.logger,
        httpClient: skills.httpClient,
      });
    } catch {
      return errorResult("Failed to load domain catalog");
    }

    let skill;
    if (skill_name) {
      let skillCatalog;
      try {
        skillCatalog = await loadSkillCatalog({
          nodeId: skills.nodeId,
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
      skill = skillCatalog.find((entry) =>
        entry.name.trim().toLowerCase() === String(skill_name).trim().toLowerCase(),
      );
    }

    const apiKey = skills.typesafeApiKey;
    if (!apiKey) return errorResult("TYPESAFE_API_KEY is not configured");

    try {
      const jevScores = await rankByRelevance({
        query: String(intent),
        items: catalogs.map((catalog) => ({ key: catalog.name, text: catalogEvaluationText(catalog) })),
        apiKey,
        ...(skill ? { context: { skill_name: skill.name, skill_description: skill.description } } : {}),
      });
      return jsonResult(rankAndComposeCatalogs({
        skill,
        catalogs,
        jevScores,
        limit: (limit as number | undefined) ?? 5,
      }));
    } catch {
      return errorResult("Skill catalog matching failed");
    }
  },
} satisfies Record<keyof typeof skillTools, McpToolHandler>;
