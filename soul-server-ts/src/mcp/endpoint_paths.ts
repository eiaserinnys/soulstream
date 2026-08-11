const INTERNAL_MCP_PATH_SUFFIX = "/internal";

/**
 * Derive the stateful endpoint reserved for Soulstream-owned agent SDKs.
 * Kept separate from transport implementation so runner-side option building
 * does not import the server transport graph.
 */
export function internalMcpPath(publicPath: string): string {
  const normalized = publicPath.endsWith("/")
    ? publicPath.slice(0, -1)
    : publicPath;
  if (normalized.endsWith(INTERNAL_MCP_PATH_SUFFIX)) return normalized;
  return `${normalized}${INTERNAL_MCP_PATH_SUFFIX}`;
}
