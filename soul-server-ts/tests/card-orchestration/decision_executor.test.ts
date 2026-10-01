import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { DecisionExecutor, claudeDecisionOptions } from '../../src/card-orchestration/decision_executor.js';
import { DockerDecisionIsolation } from '../../src/card-orchestration/docker_isolation.js';

const image = process.env.CARD_DECISION_TEST_IMAGE ?? 'node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5';
const request = { sessionId: 'a3a2a2bb-e18f-4d86-8b6a-c8264c54d35e', runId: '3f29dd17-a3b4-45ed-9ce0-88a45d7161f2', backend: 'claude' as const, model: 'test-model', prompt: 'decide', outputSchema: { type: 'object' }, signal: new AbortController().signal };

describe('dedicated decision executor', () => {
  it('removes tools, MCP, user/project settings and common environment', () => {
    const options = claudeDecisionOptions(request, '/empty', '/trusted/claude', 'oauth');
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect(options.env).toEqual({ HOME: '/empty', PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oauth' });
    expect(options.outputFormat).toEqual({ type: 'json_schema', schema: request.outputSchema });
    expect(options.persistSession).toBe(false);
  });

  it('requires structured output, never accepts assistant prose or a generic-session fallback', async () => {
    const query = vi.fn(async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: '{"order":[]}' }; });
    const executor = new DecisionExecutor({ claudeExecutable: '/trusted/claude', claudeQuery: query, credential: async () => ({ backend: 'claude', oauthToken: 'test' }) });
    await expect(executor.execute(request)).resolves.toMatchObject({ status: 'unavailable', reason: 'missing_structured_output' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('readiness exposes missing image and binary separately without a model call', async () => {
    const credential = vi.fn();
    const noImage = new DecisionExecutor({ credential });
    expect(await noImage.prepare('codex')).toEqual({ status: 'unavailable', reason: 'docker_image_unconfigured' });
    const noBinary = new DecisionExecutor({ credential, codex: { image, timeoutMs: 30000 } });
    expect(await noBinary.prepare('codex')).toEqual({ status: 'unavailable', reason: 'codex_native_binary_unconfigured' });
    expect(credential).not.toHaveBeenCalled();
  });

  // Explicit host fixture: generic CI/unit tests do not install a decision image.
  it.skipIf(!process.env.CARD_DECISION_TEST_IMAGE)('real container cannot read shared FS, host HOME/config/secret, parent env or host proc', async () => {
    const sentinel = await mkdtemp(join(tmpdir(), 'decision-host-trap-'));
    const stage = await mkdtemp(join(tmpdir(), 'decision-stage-'));
    const previousSecret = process.env.CARD_ORCHESTRATION_SENTINEL_SECRET;
    process.env.CARD_ORCHESTRATION_SENTINEL_SECRET = 'HOST_SECRET_SENTINEL';
    try {
      await writeFile(join(sentinel, 'secret'), 'HOST_SECRET_SENTINEL');
      await writeFile(join(stage, 'attack.cjs'), `const fs=require('node:fs');
const checks={};
for(const p of ${JSON.stringify([join(sentinel, 'secret'), '/home/eias/.codex/auth.json', '/home/eias/workspace/.env', '/home/eias/workspace/.projects/soulstream', '/var/run/docker.sock', '/proc/1/root/home/eias/.codex/auth.json'])}) checks[p]=!fs.existsSync(p);
checks.environment=!Object.values(process.env).some(v=>v.includes('HOST_SECRET_SENTINEL'));
checks.home=process.env.HOME==='/home/decision'&&process.env.CODEX_HOME==='/home/decision/.codex';
checks.config=!fs.existsSync('/home/decision/.codex/auth.json')&&!fs.existsSync('/home/decision/.codex/config.toml');
try {fs.writeFileSync('/etc/decision-escape','x'); checks.rootReadonly=false;}catch {checks.rootReadonly=true;}
console.log(JSON.stringify(checks));`);
      const isolation = new DockerDecisionIsolation({ image, timeoutMs: 30000 });
      const result = await isolation.run({ stageDir: stage, entrypoint: '/usr/local/bin/node', args: ['/input/attack.cjs'], signal: request.signal });
      expect(result.exitCode, result.stderr).toBe(0);
      const checks = JSON.parse(result.stdout);
      console.log("decision isolation sentinel evidence:", JSON.stringify({ observedAt: new Date().toISOString(), image, exitCode: result.exitCode, checks }));
      expect(Object.keys(checks).length).toBe(10);
      expect(Object.values(checks)).toEqual(Array(10).fill(true));
    } finally {
      if (previousSecret === undefined) delete process.env.CARD_ORCHESTRATION_SENTINEL_SECRET;
      else process.env.CARD_ORCHESTRATION_SENTINEL_SECRET = previousSecret;
      await rm(sentinel, { recursive: true, force: true });
      await rm(stage, { recursive: true, force: true });
    }
  }, 60000);

  it('refuses a credential file or CLI wrapper as the native executable mount', async () => {
    const stage = await mkdtemp(join(tmpdir(), 'decision-invalid-binary-'));
    try {
      const path = join(stage, 'not-a-binary');
      await writeFile(path, '{"secret":"test-token"}', { mode: 0o700 });
      const isolation = new DockerDecisionIsolation({ image, timeoutMs: 30000 });
      await expect(isolation.run({ stageDir: stage, codexBinary: path, entrypoint: '/usr/local/bin/node', args: [], signal: request.signal })).rejects.toThrow('native ELF');
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
});
