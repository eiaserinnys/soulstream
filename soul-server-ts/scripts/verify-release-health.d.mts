export interface HealthResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type HealthFetch = (url: URL, init?: RequestInit) => Promise<HealthResponse>;
export interface NodeRegistrationOptions {
  url: URL;
  token: string;
  nodeId: string;
  fetchImpl: HealthFetch;
  attempts?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
export interface McpHealthOptions {
  url: URL;
  token?: string;
  folderId?: string | null;
}
export interface McpHealth {
  ping: string;
  tool?: string;
  folder_id?: string | null;
}
export function deriveOrchestratorHealthUrl(upstreamUrl: string): URL;
export function deriveOrchestratorNodesUrl(upstreamUrl: string): URL;
export function deriveInternalMcpHealthUrl(env: NodeJS.ProcessEnv): URL;
export function readNodeRegistration(options: NodeRegistrationOptions): Promise<{ node_id: string; connected: boolean; status: string; connection_id: string | null; attempts: number }>;
export function readMcpHealth(options: McpHealthOptions): Promise<McpHealth>;
export function verifyReleaseHealth(options: {
  scope?: string | null;
  folderId?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetchImpl?: HealthFetch;
  nodeRead?: (options: NodeRegistrationOptions) => Promise<unknown>;
  mcpRead?: (options: McpHealthOptions) => Promise<McpHealth>;
}): Promise<{ status: string; scope: string; soul: { url: string; status: string }; mcp: McpHealth; orchestrator?: { url: string; status: string }; node?: unknown }>;
export function formatHealthError(error: unknown, env?: NodeJS.ProcessEnv): string;
