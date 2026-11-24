import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { McpHostOptions } from "../mcp/types.js";
import type { RecurringJobRouteActorResolver } from "../recurring-jobs/recurring_job_routes.js";
import type { RecurringJobService } from "../recurring-jobs/service.js";
import { RecurringJobError } from "../recurring-jobs/types.js";
import {
  DEFAULT_DOMAIN_CATALOG_NODE_ID,
  loadAtomNodeBody,
  loadDomainCatalog,
  loadSkillCatalog,
} from "./skill_catalog.js";
import { mergeSkillGuides } from "./skill_guides_merge.js";
import type { SkillLintReportStorePort } from "./skill_lint_report_store.js";

export type SkillGuidesRouteOptions = {
  readonly store: SkillLintReportStorePort;
  readonly skills: NonNullable<McpHostOptions["skills"]>;
  readonly recurringJobs: Pick<RecurringJobService, "runManual">;
  readonly resolveActor: RecurringJobRouteActorResolver;
};

export const skillGuidesRouteAuthRequirements = {
  "GET /api/skill-guides": true,
  "GET /api/skill-guides/:name/body": true,
  "POST /api/skill-guides/verify": true,
} as const;

export function registerSkillGuidesRoutes(app: FastifyInstance, options: SkillGuidesRouteOptions): void {
  const atom = { enabled: options.skills.enabled, serverUrl: options.skills.serverUrl, apiKey: options.skills.apiKey };
  const logger = options.skills.logger ?? app.log;
  const catalogNodeId = options.skills.catalogsNodeId ?? DEFAULT_DOMAIN_CATALOG_NODE_ID;

  app.get("/api/skill-guides", async (_request, reply) => {
    try {
      const [skills, catalogs, stored] = await Promise.all([
        loadSkillCatalog({ nodeId: options.skills.nodeId, atom, logger, httpClient: options.skills.httpClient }),
        loadDomainCatalog({ nodeId: catalogNodeId, atom, logger, httpClient: options.skills.httpClient }),
        options.store.get(),
      ]);
      return reply.send(mergeSkillGuides(skills, catalogs, stored));
    } catch (error) {
      return reply.code(502).send({ error: "skill_catalog_unavailable", message: error instanceof Error ? error.message : "Failed to load skill catalog" });
    }
  });

  app.get<{ Params: { name: string } }>("/api/skill-guides/:name/body", async (request, reply) => {
    let skill;
    try {
      const catalog = await loadSkillCatalog({ nodeId: options.skills.nodeId, atom, logger, httpClient: options.skills.httpClient });
      const wanted = request.params.name.trim().toLowerCase();
      skill = catalog.find((entry) => entry.name.trim().toLowerCase() === wanted);
    } catch (error) {
      return reply.code(502).send({ error: "skill_catalog_unavailable", message: error instanceof Error ? error.message : "Failed to load skill catalog" });
    }
    if (!skill) return reply.code(404).send({ error: "skill_not_found", name: request.params.name });
    try {
      const body = await loadAtomNodeBody({
        bodyNodeId: skill.bodyNodeId, nodeId: options.skills.nodeId, atom, logger, httpClient: options.skills.httpClient,
      });
      return reply.send({ name: skill.name, body_node_id: skill.bodyNodeId, markdown: body.markdown });
    } catch (error) {
      return reply.code(502).send({ error: "skill_body_unavailable", message: error instanceof Error ? error.message : "Failed to load skill body" });
    }
  });

  app.post("/api/skill-guides/verify", async (request, reply) => {
    const actor = await options.resolveActor(request);
    if (!actor) return reply.code(401).send({ detail: { error: { code: "AUTHENTICATED_ACTOR_REQUIRED", message: "Authenticated user identity is required" } } });
    const jobId = (await options.store.get())?.verify_job_id ?? null;
    if (!jobId) return reply.code(409).send({ error: "no_verify_job" });
    try {
      await options.recurringJobs.runManual(actor, jobId, `skill-guides-verify-${randomUUID()}`);
      return reply.code(202).send({ job_id: jobId });
    } catch (error) {
      if (error instanceof RecurringJobError) {
        return reply.code(error.statusCode).send({ detail: { error: { code: error.code, message: error.message } } });
      }
      throw error;
    }
  });
}
