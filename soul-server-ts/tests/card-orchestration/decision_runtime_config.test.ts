import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/config.js';

const minimal = { SOULSTREAM_NODE_ID: 'node', SOULSTREAM_UPSTREAM_URL: 'ws://localhost:5200/ws/node', EVENT_OUTBOX_DIR: '/tmp/decision-outbox' };
describe('decision isolation runtime configuration', () => {
  it('does not invent a container image or credential/binary location when unconfigured', () => {
    const config = parseEnv(minimal);
    expect(config.CARD_DECISION_DOCKER_IMAGE).toBeUndefined();
    expect(config.CARD_DECISION_CODEX_BINARY_PATH).toBeUndefined();
    expect(config.CARD_DECISION_CLAUDE_EXECUTABLE_PATH).toBeUndefined();
    expect(config.CARD_DECISION_TIMEOUT_MS).toBe(300000);
  });
  it('rejects mutable image tags and relative executable paths', () => {
    expect(() => parseEnv({ ...minimal, CARD_DECISION_DOCKER_IMAGE: 'node:latest' })).toThrow();
    expect(() => parseEnv({ ...minimal, CARD_DECISION_CODEX_BINARY_PATH: '../auth.json' })).toThrow();
  });
});
