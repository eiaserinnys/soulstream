import type { AgentProfile } from "../agent_registry.js";
import type { Task } from "../task/task_models.js";

/** Neutral result used until a session has a durable page anchor. */
export interface NoPageAnchorContext {
  kind: "no-page-anchor";
}

export type PageContextResolution = NoPageAnchorContext;

/** Boundary for resolving page-owned context before the first engine turn. */
export interface PageContextResolver {
  resolve(task: Task, agent: AgentProfile): Promise<PageContextResolution>;
}

export class NoPageAnchorContextResolver implements PageContextResolver {
  async resolve(_task: Task, _agent: AgentProfile): Promise<NoPageAnchorContext> {
    return { kind: "no-page-anchor" };
  }
}

export const NO_PAGE_ANCHOR_CONTEXT_RESOLVER: PageContextResolver =
  new NoPageAnchorContextResolver();
