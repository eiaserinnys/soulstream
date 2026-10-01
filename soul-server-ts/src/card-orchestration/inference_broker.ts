import { createServer, type Server } from 'node:http';
import { chmod } from 'node:fs/promises';

export interface CodexDecisionCredential { backend: 'codex'; oauthToken: string; accountId: string }
export interface InferenceRequest { body: string; credential: CodexDecisionCredential; signal: AbortSignal }
export interface InferenceResponse { status: number; contentType: string; body: AsyncIterable<Uint8Array> }
export type InferenceForwarder = (request: InferenceRequest) => Promise<InferenceResponse>;

/** OAuth stays in the host process. The mounted socket permits only this run's model inference. */
export class DecisionInferenceBroker {
  private server: Server | undefined;
  private requests = 0;
  constructor(private readonly options: {
    socketPath: string; model: string; credential: CodexDecisionCredential;
    signal: AbortSignal; forward?: InferenceForwarder;
  }) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/responses' || this.requests >= 8 || this.options.signal.aborted) {
          response.writeHead(403).end('inference_denied'); return;
        }
        this.requests++;
        let body = '';
        for await (const chunk of request) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 4 * 1024 * 1024) { response.writeHead(413).end(); return; }
        }
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
        if (!isInferenceBody(parsed, this.options.model)) { response.writeHead(403).end('inference_denied'); return; }
        const result = await (this.options.forward ?? forwardCodexInference)({
          body, credential: this.options.credential, signal: this.options.signal,
        });
        response.writeHead(result.status, { 'content-type': result.contentType });
        for await (const chunk of result.body) {
          if (!response.write(chunk)) await new Promise<void>((resolve) => response.once('drain', resolve));
        }
        response.end();
      })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end('inference_unavailable'); });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.socketPath, () => resolve());
    });
    await chmod(this.options.socketPath, 0o600);
  }

  async close(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => { if (this.server) this.server.close(() => resolve()); else resolve(); });
  }
}

function isInferenceBody(value: unknown, model: string): boolean {
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).model !== model) return false;
  // Hosted tools execute outside our OS boundary. Local function tools remain inside the container.
  const record = value as Record<string, unknown>;
  const tools = record.tools;
  if (tools !== undefined && !localToolsOnly(tools)) return false;
  return true;
}

function localToolsOnly(tools: unknown): boolean {
  return Array.isArray(tools) && tools.every((tool) => {
    if (!tool || typeof tool !== 'object') return false;
    const record = tool as Record<string, unknown>;
    if (record.type === 'namespace') return localToolsOnly(record.tools);
    return record.type === 'function' || record.type === 'custom';
  });
}

async function forwardCodexInference(request: InferenceRequest): Promise<InferenceResponse> {
  const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', signal: request.signal,
    headers: {
      authorization: `Bearer ${request.credential.oauthToken}`,
      'chatgpt-account-id': request.credential.accountId,
      'content-type': 'application/json', originator: 'codex_cli_rs',
    }, body: request.body,
  });
  return { status: response.status, contentType: response.headers.get('content-type') ?? 'text/event-stream',
    body: response.body ?? (async function* () {})() };
}
