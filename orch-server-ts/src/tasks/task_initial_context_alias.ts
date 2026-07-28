import type { InitialTaskContext } from "@soulstream/page-model";

export function canonicalizeInitialTaskContext(
  context: InitialTaskContext | undefined,
  resolveAgentId: ((nodeId: string, agentId: string) => string) | undefined,
): InitialTaskContext | undefined {
  const defaults = context?.sessionDefaults;
  if (!context || !defaults || !resolveAgentId) return context;
  return {
    ...context,
    sessionDefaults: {
      ...defaults,
      agentId: resolveAgentId(defaults.nodeId, defaults.agentId),
    },
  };
}
