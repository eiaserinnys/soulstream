export const REFLECTION_SCHEMA_VERSION = "soulstream.reflect.v1";
export const SELF_SERVICE_NAME = "soul-server-ts";

export const SELF_IDENTITY = {
  name: SELF_SERVICE_NAME,
  description:
    "Soulstream TypeScript worker with a Streamable HTTP MCP endpoint.",
  capabilities: [
    {
      name: "mcp_tools",
      description: "도구 이름의 현재 등록 인벤토리",
      tools: [],
    },
  ],
} as const;

export function filterCapabilities(capability?: string, tools: string[] = []) {
  if (capability && capability !== "mcp_tools") return [];
  return [{ ...SELF_IDENTITY.capabilities[0], tools: [...tools].sort() }];
}
