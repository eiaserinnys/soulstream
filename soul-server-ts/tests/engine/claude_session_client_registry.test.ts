import { describe, expect, it, vi } from "vitest";

import type {
  ClaudeClient,
  ClaudeRunOptions,
} from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from "../../src/engine/claude_session_client_registry.js";
import type { ClaudeClientEvent } from "../../src/engine/claude_event_mapper.js";

describe("ClaudeSessionClientRegistry", () => {
  it("reuses one client per session and closes it only on explicit removal", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const createClient = vi.fn(
      (): ClaudeClient => ({
        async *run(
          _options: ClaudeRunOptions,
          _signal: AbortSignal,
        ): AsyncIterable<ClaudeClientEvent> {},
        close,
      }),
    );
    const registry = new ClaudeSessionClientRegistry(createClient);

    expect(registry.acquire("session-1")).toBe(registry.acquire("session-1"));
    expect(registry.acquire("session-2")).not.toBe(registry.acquire("session-1"));
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(2);

    await registry.close("session-1");
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(1);

    await registry.shutdown();
    expect(close).toHaveBeenCalledTimes(2);
    expect(registry.size()).toBe(0);
  });
});
