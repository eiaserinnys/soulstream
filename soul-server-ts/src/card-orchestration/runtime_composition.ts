import type { AuthorizeOrchestrationWorker } from '../upstream/task_runtime_commands.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { AgentRegistry } from '../agent_registry.js';
import type { NewSessionAgentProfileSource } from '../agent_profile_source.js';
import { FileClaudeAuthTokenStore } from '../auth/claude_auth.js';
import type { SessionMutationHost } from '../control_plane/persistence_host_clients.js';
import { fetchOrchResponse } from '../control_plane/persistence_host_transport.js';
import type { EventPersistence } from '../db/event_persistence.js';
import { resolveClaudeExecutableFromPath } from '../engine/claude_executable_path.js';
import type { ModelCatalog } from '../model_catalog.js';
import type { OrchProxyConfig } from '../mcp/runtime.js';
import type { TaskManager } from '../task/task_manager.js';
import { DecisionExecutor, type DecisionCredential } from './decision_executor.js';
import { PurposeDecisionRunner } from './purpose_runner.js';
import { compileDecisionInstructions } from './decision_instructions.js';
import type { AtomFetchConfig } from '../context/atom_context.js';

export interface DecisionRuntimeSettings {
  claudeAuthTokenPath?: string;
  claudeExecutable?: string;
  dockerImage?: string;
  codexBinaryPath?: string;
  timeoutMs: number;
}

export function composePurposeDecisionRunner(params: {
  nodeId: string; settings: DecisionRuntimeSettings; logger: Logger;
  taskManager: TaskManager; persistence: EventPersistence; modelCatalog: ModelCatalog;
  sessionMutations: SessionMutationHost; orch: OrchProxyConfig;
  agentRegistry: AgentRegistry; agentProfileSource?: NewSessionAgentProfileSource;
  atom: AtomFetchConfig;
}): PurposeDecisionRunner {
  const { settings } = params;
  const claudeExecutable = settings.claudeExecutable ?? resolveClaudeExecutableFromPath();
  const executor = new DecisionExecutor({
    claudeExecutable,
    credential: (backend) => readDecisionCredential(backend, settings.claudeAuthTokenPath),
    codex: {
      image: settings.dockerImage, binaryPath: settings.codexBinaryPath, timeoutMs: settings.timeoutMs,
    },
  });
  return new PurposeDecisionRunner({
    nodeId: params.nodeId, taskManager: params.taskManager, persistence: params.persistence,
    modelCatalog: params.modelCatalog, executor, timeoutMs: settings.timeoutMs,
    resolveProfile: async (id) => params.agentProfileSource
      ? (await params.agentProfileSource.resolve(id))?.profile
      : params.agentRegistry.get(id),
    compileInstructions: (profile) => compileDecisionInstructions(profile, params.atom, params.logger),
    authorize: async (command) => {
      const response = await fetchOrchResponse(params.orch, 'POST', '/api/card-orchestration/decision/authorize', {
        sessionId: command.agentSessionId, runId: command.runId,
        executionToken: command.leaseToken, nodeId: params.nodeId,
      });
      if (!response.ok) return false;
      return (await response.json() as { allowed?: unknown }).allowed === true;
    },
    transitionRunning: (sessionId, runId) => params.sessionMutations.transitionSession(
      sessionId, { status: 'running' }, `card_orchestration_start:${runId}:${sessionId}`),
    onPersistenceError: (sessionId) => params.logger.error({ sessionId }, 'Decision result persistence failed; durable run reconciliation required'),
  });
}

/** Reads OAuth only in the host. Never returns an auth file, refresh token, profile env or API key. */
export async function readDecisionCredential(backend: 'claude' | 'codex',
  claudeAuthTokenPath?: string, codexHome: string = homedir()): Promise<DecisionCredential | undefined> {
  try {
    if (backend === 'claude') {
      const oauthToken = new FileClaudeAuthTokenStore(claudeAuthTokenPath).read()?.accessToken;
      return oauthToken ? { backend, oauthToken } : undefined;
    }
    const auth: unknown = JSON.parse(await readFile(join(codexHome, '.codex', 'auth.json'), 'utf8'));
    if (!isRecord(auth)) return undefined;
    const tokens = isRecord(auth.tokens) ? auth.tokens : auth;
    const oauthToken = typeof tokens.access_token === 'string' ? tokens.access_token : undefined;
    const accountId = typeof tokens.account_id === 'string' ? tokens.account_id
      : typeof auth.account_id === 'string' ? auth.account_id : undefined;
    return oauthToken && accountId ? { backend, oauthToken, accountId } : undefined;
  } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Host admission applies only to explicit orchestration tokens; caller cannot choose node identity. */
export function composeWorkerAdmissionAuthorizer(orch: OrchProxyConfig, nodeId: string): AuthorizeOrchestrationWorker {
  return async (request) => {
    const response = await fetchOrchResponse(orch, 'POST', '/api/card-orchestration/worker/authorize', {
      sessionId: request.sessionId, cardId: request.cardId, nodeId,
      runId: request.runId, executionToken: request.executionToken,
    });
    if (!response.ok) return false;
    return (await response.json() as { allowed?: unknown }).allowed === true;
  };
}
