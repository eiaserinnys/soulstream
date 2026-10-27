import { errorResult, jsonResult, type skillTools } from "@soulstream/mcp-contract";
import { rankByRelevance } from "../relevance/typesafe_client.js";
import {
  catalogEvaluationText,
  DEFAULT_DOMAIN_CATALOG_NODE_ID,
  loadAtomNodeBody,
  loadAtomNodeMetadata,
  loadDomainCatalog,
  loadSkillCatalog,
  rankAndComposeCatalogs,
} from "../skills/skill_catalog.js";
import { compileSkill } from "../skills/skill_compile.js";
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
  load_skill: async (options, { name, intent, pins }) => {
    const skills = options.skills;
    if (!skills?.logger) return errorResult("skill loading is not configured");

    const deadlineAt = Date.now() + 170_000;
    let catalog;
    try {
      catalog = await loadSkillCatalog({
        nodeId: skills.nodeId,
        atom: { enabled: skills.enabled, serverUrl: skills.serverUrl, apiKey: skills.apiKey },
        logger: skills.logger,
        httpClient: skills.httpClient,
      });
    } catch {
      return errorResult("Failed to load skill catalog");
    }

    const skill = catalog.find((entry) =>
      entry.name.trim().toLowerCase() === String(name).trim().toLowerCase(),
    );
    if (!skill) return errorResult(`Skill not found: ${String(name)}`);
    if (!skill.nodeId) return errorResult(`Skill catalog entry has no source node id: ${skill.name}`);

    const atom = { enabled: skills.enabled, serverUrl: skills.serverUrl, apiKey: skills.apiKey };
    try {
      const [entryMetadata, body] = await Promise.all([
        loadAtomNodeMetadata({ bodyNodeId: skill.nodeId, nodeId: skills.nodeId, atom, logger: skills.logger, httpClient: skills.httpClient }),
        loadAtomNodeBody({ bodyNodeId: skill.bodyNodeId, nodeId: skills.nodeId, atom, logger: skills.logger, httpClient: skills.httpClient }),
      ]);
      return jsonResult(await compileSkill({
        skill,
        entryVersion: entryMetadata.version,
        body,
        skills: catalog,
        readBody: (bodyNodeId) => loadAtomNodeBody({
          bodyNodeId,
          nodeId: skills.nodeId,
          atom,
          logger: skills.logger!,
          httpClient: skills.httpClient,
        }),
        loadCatalogs: () => loadDomainCatalog({
          nodeId: skills.catalogsNodeId ?? DEFAULT_DOMAIN_CATALOG_NODE_ID,
          atom,
          logger: skills.logger!,
          httpClient: skills.httpClient,
        }),
        score: async ({ query, items, context, timeoutMs }) => {
          if (!skills.typesafeApiKey) throw new Error("Typesafe API key is unavailable");
          return rankByRelevance({
            query,
            items,
            context,
            timeoutMs,
            strictScores: true,
            apiKey: skills.typesafeApiKey,
          });
        },
        ...(typeof intent === "string" ? { intent } : {}),
        ...(Array.isArray(pins) ? { pins: pins as string[] } : {}),
        deadlineAt,
      }));
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "Skill loading failed");
    }
  },
} satisfies Record<keyof typeof skillTools, McpToolHandler>;
