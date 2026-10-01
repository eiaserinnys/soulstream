import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type Options as ClaudeOptions } from '@anthropic-ai/claude-agent-sdk';
import { DockerDecisionIsolation } from './docker_isolation.js';
import { DecisionInferenceBroker, type CodexDecisionCredential, type InferenceForwarder } from './inference_broker.js';
import { CODEX_CONTAINER_PROGRAM } from './codex_container_program.js';

export interface DecisionExecutionRequest {
  sessionId: string; runId: string; backend: 'claude' | 'codex'; model: string;
  prompt: string; outputSchema: Record<string, unknown>; signal: AbortSignal;
}
export type DecisionExecutionResult = { status: 'ready'; output: unknown }
  | { status: 'unavailable'; reason: string };
export type DecisionCredential = { backend: 'claude'; oauthToken: string } | CodexDecisionCredential;
interface ClaudeDecisionEvent { type: string; subtype?: string; is_error?: boolean; structured_output?: unknown }
type ClaudeDecisionQuery = (params: { prompt: string; options: ClaudeOptions }) => AsyncIterable<ClaudeDecisionEvent>;

export interface DecisionExecutorOptions {
  claudeExecutable?: string;
  /** Host-only reader, not a profile env map. Returns only the selected inference identity. */
  credential: (backend: DecisionExecutionRequest['backend']) => Promise<DecisionCredential | undefined>;
  claudeQuery?: ClaudeDecisionQuery;
  codex?: { image?: string; binaryPath?: string; timeoutMs: number; dockerPath?: string };
  /** Only tests replace the fixed production inference endpoint. */
  inferenceForward?: InferenceForwarder;
}

export function claudeDecisionOptions(request: DecisionExecutionRequest, directory: string,
  executable: string, oauthToken: string): ClaudeOptions {
  return {
    cwd: directory, pathToClaudeCodeExecutable: executable,
    env: { HOME: directory, PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
    tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true,
    settingSources: [], plugins: [], persistSession: false,
    permissionMode: 'dontAsk',
    canUseTool: async () => ({ behavior: 'deny', message: 'Decision sessions have no tool authority' }),
    model: request.model,
    outputFormat: { type: 'json_schema', schema: request.outputSchema },
    maxTurns: 4,
  };
}

/** No general task/session engine, profile MCP, profile workspace or ambient environment is used here. */
export class DecisionExecutor {
  constructor(private readonly options: DecisionExecutorOptions) {}

  /** Infrastructure/credential readiness only; does not create a session or issue inference. */
  async prepare(backend: 'claude' | 'codex'): Promise<{ status: 'ready' } | { status: 'unavailable'; reason: string }> {
    try {
      if (backend === 'codex') {
        const config = this.options.codex;
        if (!config?.image) return unavailable('docker_image_unconfigured');
        if (!config.binaryPath) return unavailable('codex_native_binary_unconfigured');
        await new DockerDecisionIsolation({ ...config, image: config.image }).prepare(config.binaryPath);
      } else {
        if (!this.options.claudeExecutable) return unavailable('claude_executable_unavailable');
        const executable = await stat(this.options.claudeExecutable);
        if (!executable.isFile() || !(executable.mode & 0o111)) return unavailable('claude_executable_unavailable');
      }
      let credential: DecisionCredential | undefined;
      try { credential = await this.options.credential(backend); } catch { return unavailable('credential_unavailable'); }
      if (!credential || credential.backend !== backend || !credential.oauthToken) return unavailable('credential_unavailable');
      return { status: 'ready' };
    } catch (error) {
      if (backend === 'codex' && error instanceof Error && ['codex_native_binary_unavailable', 'docker_image_or_daemon_unavailable'].includes(error.message)) return unavailable(error.message);
      return unavailable(backend === 'codex' ? 'isolated_codex_unavailable' : 'claude_executable_unavailable');
    }
  }

  async execute(request: DecisionExecutionRequest): Promise<DecisionExecutionResult> {
    if (request.signal.aborted) return unavailable('decision_aborted');
    if (!request.model || !request.runId || !request.sessionId) return unavailable('invalid_request');
    if (request.backend === 'claude' && !this.options.claudeExecutable) return unavailable('claude_executable_unavailable');
    if (request.backend === 'codex' && !this.options.codex?.image) return unavailable('docker_image_unconfigured');
    if (request.backend === 'codex' && !this.options.codex?.binaryPath) return unavailable('codex_native_binary_unconfigured');
    let credential: DecisionCredential | undefined;
    try { credential = await this.options.credential(request.backend); }
    catch { return unavailable('credential_unavailable'); }
    if (!credential || credential.backend !== request.backend || !credential.oauthToken) return unavailable('credential_unavailable');
    if (request.signal.aborted) return unavailable('decision_aborted');
    const directory = await mkdtemp(join(tmpdir(), 'soul-decision-'));
    try {
      if (request.backend === 'claude') return await this.claude(request, directory, credential.oauthToken);
      return await this.codex(request, directory, credential as CodexDecisionCredential);
    } catch { return unavailable(request.signal.aborted ? 'decision_aborted' : 'executor_unavailable'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async claude(request: DecisionExecutionRequest, directory: string, oauth: string): Promise<DecisionExecutionResult> {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (request.signal.aborted) abort();
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      const runQuery = this.options.claudeQuery ?? query;
      const options = { ...claudeDecisionOptions(request, directory, this.options.claudeExecutable!, oauth), abortController };
      for await (const event of runQuery({ prompt: request.prompt, options })) {
        if (event.type !== 'result') continue;
        if (event.subtype !== 'success' || event.is_error) return unavailable('model_rejected');
        if (event.structured_output === undefined) return unavailable('missing_structured_output');
        return { status: 'ready', output: event.structured_output };
      }
      return unavailable('missing_terminal_output');
    } finally { request.signal.removeEventListener('abort', abort); }
  }

  private async codex(request: DecisionExecutionRequest, directory: string,
    credential: CodexDecisionCredential): Promise<DecisionExecutionResult> {
    const config = this.options.codex!;
    if (!config.image || !config.binaryPath) return unavailable('isolation_unconfigured');
    const broker = new DecisionInferenceBroker({ socketPath: join(directory, 'inference.sock'),
      model: request.model, credential, signal: request.signal, forward: this.options.inferenceForward });
    try {
      await writeFile(join(directory, 'runtime.cjs'), CODEX_CONTAINER_PROGRAM, { mode: 0o600 });
      await writeFile(join(directory, 'request.json'), JSON.stringify({ model: request.model, prompt: request.prompt }), { mode: 0o600 });
      await writeFile(join(directory, 'schema.json'), JSON.stringify(request.outputSchema), { mode: 0o600 });
      await broker.start();
      const result = await new DockerDecisionIsolation({ ...config, image: config.image }).run({ stageDir: directory,
        codexBinary: config.binaryPath, entrypoint: '/usr/local/bin/node', args: ['/input/runtime.cjs'], signal: request.signal });
      if (result.exitCode !== 0) return unavailable('isolated_codex_unavailable');
      let text: string | undefined;
      for (const line of result.stdout.split('\n')) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
      }
      if (!text) return unavailable('missing_structured_output');
      return { status: 'ready', output: JSON.parse(text) as unknown };
    } finally { await broker.close(); }
  }
}

function unavailable(reason: string): { status: 'unavailable'; reason: string } { return { status: 'unavailable', reason }; }
