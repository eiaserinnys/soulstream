import type { AgentsSdkHostedTool } from "@soulstream/agent-profile-contract";

export function resolveCentralTemplate(value: string, env: Record<string, string | undefined>, label: string): string {
  if (/\{\{secret:[^}]*\}\}/.test(value)) throw new Error(`${label} contains unresolved secret reference`);
  return value.replace(/\{\{env:([A-Za-z0-9][A-Za-z0-9._-]{0,63})\}\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (!resolved) throw new Error(`${label} env ${name} is not set`);
    return resolved;
  });
}

export function resolveHostedTool(tool: AgentsSdkHostedTool, env: Record<string, string | undefined>): AgentsSdkHostedTool {
  if (tool.type !== "hosted_mcp") return tool;
  const resolve = (value: string) => resolveCentralTemplate(value, env, `MCP hosted tool ${tool.server_label}`);
  return {
    ...tool,
    ...(tool.server_url ? { server_url: resolve(tool.server_url) } : {}),
    ...(tool.authorization ? { authorization: resolve(tool.authorization) } : {}),
    ...(tool.headers ? { headers: Object.fromEntries(Object.entries(tool.headers).map(([key, value]) => [key, resolve(value)])) } : {}),
  };
}
