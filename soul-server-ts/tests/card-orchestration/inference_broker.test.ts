import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import { DecisionInferenceBroker } from '../../src/card-orchestration/inference_broker.js';
import { DecisionExecutor } from '../../src/card-orchestration/decision_executor.js';

const credential = { backend: 'codex' as const, oauthToken: 'FAKE_HOST_ONLY_OAUTH', accountId: 'fake-account' };
const signal = new AbortController().signal;

describe('inference-only broker', () => {
  it('rejects wrong model, non-inference routes and hosted tools without invoking authenticated upstream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'decision-broker-'));
    const socketPath = join(directory, 'broker.sock');
    const forward = vi.fn(async () => ({ status: 200, contentType: 'text/plain', body: (async function* () { yield Buffer.from('ok'); })() }));
    const broker = new DecisionInferenceBroker({ socketPath, model: 'approved', credential, signal, forward });
    const post = (path: string, body: unknown) => new Promise<number>((resolve, reject) => {
      const req = request({ socketPath, method: 'POST', path }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    try {
      await broker.start();
      expect(await post('/admin', { model: 'approved' })).toBe(403);
      expect(await post('/responses', { model: 'other' })).toBe(403);
      expect(await post('/responses', { model: 'approved', tools: [{ type: 'mcp', server_url: 'https://host' }] })).toBe(403);
      expect(await post('/responses', { model: 'approved', tools: [{ type: 'namespace', name: 'remote', tools: [{ type: 'web_search' }] }] })).toBe(403);
      expect(forward).not.toHaveBeenCalled();
      expect(await post('/responses', { model: 'approved', tools: [] })).toBe(200);
      expect(forward).toHaveBeenCalledTimes(1);
      expect(forward.mock.calls[0]?.[0]).toMatchObject({ credential });
      console.log('decision broker denial evidence:', JSON.stringify({ observedAt: new Date().toISOString(), rejectedRoutesAndTools: 4, authenticatedForwardsBeforeAllowedRequest: 0, finalAuthenticatedForwards: forward.mock.calls.length }));
    } finally { await broker.close(); await rm(directory, { recursive: true, force: true }); }
  });

  // Native CLI integration requires operator-prepared fixtures; never read production auth.
  it.skipIf(!process.env.CARD_DECISION_TEST_IMAGE || !process.env.CARD_DECISION_TEST_CODEX_BINARY_PATH)('runs the actual installed Codex in OS isolation with fake broker inference and structured JSON output', async () => {
    const output = '{"order":[],"reason":"no eligible work"}';
    const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: output, annotations: [] }] };
    const response = { id: 'resp_test', object: 'response', created_at: 1, model: 'test-model', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: output },
      { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: output },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response },
    ];
    const forward = vi.fn(async ({ body, credential: received }: { body: string; credential: typeof credential }) => {
      expect(received.oauthToken).toBe(credential.oauthToken);
      expect(body).not.toContain(credential.oauthToken);
      expect(JSON.parse(body).model).toBe('test-model');
      return { status: 200, contentType: 'text/event-stream', body: (async function* () {
        for (const event of events) yield Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      })() };
    });
    const executor = new DecisionExecutor({ claudeExecutable: '/not-used', credential: async () => credential,
      codex: { image: process.env.CARD_DECISION_TEST_IMAGE!,
        binaryPath: process.env.CARD_DECISION_TEST_CODEX_BINARY_PATH!, timeoutMs: 30000 }, inferenceForward: forward });
    const result = await executor.execute({ sessionId: 'visible', runId: 'run', backend: 'codex', model: 'test-model', prompt: 'Return the structured decision.',
      outputSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['order', 'reason'], additionalProperties: false }, signal });
    expect(result).toEqual({ status: 'ready', output: JSON.parse(output) });
    expect(forward).toHaveBeenCalledTimes(1);
    console.log('decision native fake inference evidence:', JSON.stringify({ observedAt: new Date().toISOString(), result, authenticatedForwards: forward.mock.calls.length, actualProviderCalls: 0, fakeOAuth: true }));
  }, 60000);
});
