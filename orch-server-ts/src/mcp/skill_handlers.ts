import { errorResult, jsonResult, type skillTools } from "@soulstream/mcp-contract";
import { rankByRelevance } from "../relevance/typesafe_client.js";
import {
  CatalogFetchError,
  catalogEvaluationText,
  DEFAULT_DOMAIN_CATALOG_NODE_ID,
  loadAtomNodeBody,
  loadAtomNodeMetadata,
  loadDomainCatalog,
  loadSkillCatalog,
  rankAndComposeCatalogs,
} from "../skills/skill_catalog.js";
import { compileSkill } from "../skills/skill_compile.js";
import { rankSkillsLexically } from "../skills/skill_lexical_search.js";
import type { McpToolHandler } from "./types.js";

function catalogLoadError(error: unknown, fallback: string): string {
  if (error instanceof Error && (
    error.message === "Skill catalog response was truncated" ||
    error.message === "Domain catalog response was truncated"
  )) return error.message;
  if (error instanceof CatalogFetchError) return `${fallback}: ${error.reason}`;
  return fallback;
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
      } catch (error) {
        return errorResult(catalogLoadError(error, "Failed to load skill catalog"));
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
      if (!apiKey) return jsonResult({
        mode: "lexical",
        query,
        matches: rankSkillsLexically(String(query), catalog, (limit as number | undefined) ?? 5).map(({ entry, score }) => ({
          name: entry.name,
          description: entry.description,
          body_node_id: entry.bodyNodeId,
          score,
        })),
      });

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
    } catch (error) {
      return errorResult(catalogLoadError(error, "Failed to load domain catalog"));
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
      } catch (error) {
        return errorResult(catalogLoadError(error, "Failed to load skill catalog"));
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
  put_skill_lint_report: async (options, { report }, context) => {
    const store = options.skillLintReport;
    if (!store) return errorResult("skill lint report storage is not configured");
    const body = report as Record<string, unknown>;
    if (typeof body.generated_at !== "string" || !Array.isArray(body.skills)) {
      return errorResult("린트 보고는 generated_at 문자열과 skills 배열을 가진 객체여야 합니다.");
    }
    // 반복 예약 실행이 올린 보고만 verify_job_id를 새로 잇고, 그 밖에는 store가 이전 값을 유지한다.
    const run = context.callerSessionId
      ? await options.recurringJobs.service.getRunBySessionId(context.callerSessionId)
      : null;
    await store.put({
      report: body,
      sessionId: context.callerSessionId,
      nodeId: context.nodeId,
      verifyJobId: run?.jobId ?? null,
    });
    return jsonResult({
      ok: true,
      generated_at: body.generated_at,
      skill_count: body.skills.length,
      catalog_count: Array.isArray(body.catalogs) ? body.catalogs.length : 0,
    });
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
    } catch (error) {
      return errorResult(catalogLoadError(error, "Failed to load skill catalog"));
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
        readBody: (bodyNodeId, readOptions) => loadAtomNodeBody({
          bodyNodeId,
          nodeId: skills.nodeId,
          atom,
          logger: skills.logger!,
          httpClient: skills.httpClient,
          ...(readOptions?.depth !== undefined ? { depth: readOptions.depth } : {}),
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
