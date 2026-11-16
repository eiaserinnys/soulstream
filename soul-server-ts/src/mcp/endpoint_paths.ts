const INTERNAL_MCP_PATH_SUFFIX = "/internal";

/**
 * Derive the node-local endpoint reserved for Soulstream-owned agent SDKs.
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

export function localInternalMcpUrl(port: number, publicPath: string): string {
  const url = new URL(`http://127.0.0.1:${port}`);
  url.pathname = internalMcpPath(publicPath);
  return url.toString();
}

/**
 * 노드 프로세스 환경에서 내부 MCP 리스너 주소를 만든다.
 *
 * 서버 config와 같은 출처다: `MCP_INTERNAL_PORT`가 없으면 `PORT + 1`,
 * `MCP_PATH`가 없으면 `/mcp`(config.ts의 기본값). 세션 안에서는 부모의
 * env가 그대로 내려오므로 CLI가 같은 주소를 얻는다.
 */
export function localInternalMcpUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const rawPort = env.MCP_INTERNAL_PORT?.trim();
  const port = rawPort ? Number(rawPort) : Number(env.PORT) + 1;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      "MCP_INTERNAL_PORT or PORT+1 is required to locate the local soul-server",
    );
  }
  const publicPath = env.MCP_PATH?.trim() || "/mcp";
  return localInternalMcpUrl(port, publicPath);
}
