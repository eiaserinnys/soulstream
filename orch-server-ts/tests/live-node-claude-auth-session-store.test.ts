import { describe, expect, it } from "vitest";

import {
  createLiveNodeClaudeAuthSessionStore,
} from "../src/index.js";
import { createClaudeAuthHarness } from "./node-claude-auth-test-helpers.js";

describe("live node Claude auth session store", () => {
  it("matches the Python in-memory TTL Map create/pop semantics", async () => {
    let nowMs = 1_000;
    const store = createLiveNodeClaudeAuthSessionStore({
      nowMs: () => nowMs,
      ttlMs: 100,
    });

    await store.create("old", "old-verifier", { metadata: { node_id: "node-old" } });
    nowMs = 1_100;
    await store.create("boundary", "boundary-verifier", {
      metadata: { node_id: "node-boundary" },
    });
    nowMs = 1_101;
    await store.create("fresh", "fresh-verifier", {
      metadata: { node_id: "node-fresh" },
    });

    nowMs = 1_000;
    expect(await store.pop("old")).toBeUndefined();

    nowMs = 1_200;
    expect(await store.pop("boundary")).toEqual({
      verifier: "boundary-verifier",
      metadata: { node_id: "node-boundary" },
    });

    nowMs = 1_202;
    expect(await store.pop("fresh")).toBeUndefined();
    nowMs = 1_000;
    expect(await store.pop("fresh")).toBeUndefined();
  });

  it("uses live session store state for browser start and callback", async () => {
    const store = createLiveNodeClaudeAuthSessionStore({ ttlMs: 300_000 });
    const { app, sent, tokenRequests } = createClaudeAuthHarness({
      sessionStore: store,
      pkce: fixedPkce("browser-state"),
    });

    const start = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/start",
    });
    expect(start.statusCode).toBe(302);

    const callback = await app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=callback-code&state=browser-state",
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/?claude_auth=success");
    expect(tokenRequests[0]?.data.code_verifier).toBe("verifier-browser-state");
    expect(sent).toEqual([expect.objectContaining({ type: "claude_auth_set_token" })]);

    const replay = await app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=callback-code&state=browser-state",
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ detail: "Invalid or expired OAuth state" });

    await app.close();
  });

  it("keeps expired browser callback and headless submit responses unchanged", async () => {
    let nowMs = 10_000;
    const store = createLiveNodeClaudeAuthSessionStore({
      nowMs: () => nowMs,
      ttlMs: 100,
    });
    const { app } = createClaudeAuthHarness({
      sessionStore: store,
      pkce: sequentialPkce(["expired-browser", "expired-headless"]),
    });

    await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/start",
    });
    nowMs = 10_101;
    const browserCallback = await app.inject({
      method: "GET",
      url: "/api/nodes/claude-auth/callback?code=x&state=expired-browser",
    });
    expect(browserCallback.statusCode).toBe(400);
    expect(browserCallback.json()).toEqual({
      detail: "Invalid or expired OAuth state",
    });

    nowMs = 20_000;
    await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/headless/start",
    });
    nowMs = 20_101;
    const headlessSubmit = await app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "auth-code#expired-headless" },
    });
    expect(headlessSubmit.statusCode).toBe(400);
    expect(headlessSubmit.json()).toEqual({ detail: "invalid_state" });

    await app.close();
  });

  it("uses live session store state for headless start and submit-code", async () => {
    const store = createLiveNodeClaudeAuthSessionStore({ ttlMs: 300_000 });
    const { app, sent, tokenRequests } = createClaudeAuthHarness({
      sessionStore: store,
      pkce: fixedPkce("headless-state"),
    });

    const start = await app.inject({
      method: "GET",
      url: "/api/nodes/fake-node/claude-auth/headless/start",
    });
    expect(start.statusCode).toBe(200);

    const submit = await app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "headless-code#headless-state" },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json()).toEqual({ success: true });
    expect(tokenRequests[0]?.data.code_verifier).toBe("verifier-headless-state");
    expect(sent).toEqual([expect.objectContaining({ type: "claude_auth_set_token" })]);

    const replay = await app.inject({
      method: "POST",
      url: "/api/nodes/fake-node/claude-auth/headless/submit-code",
      payload: { code: "headless-code#headless-state" },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toEqual({ detail: "invalid_state" });

    await app.close();
  });
});

function fixedPkce(state: string) {
  return {
    generateVerifier: () => `verifier-${state}`,
    generateChallenge: () => `challenge-${state}`,
    generateState: () => state,
  };
}

function sequentialPkce(states: string[]) {
  const queue = [...states];
  return {
    generateVerifier: () => `verifier-${queue[0] ?? "missing"}`,
    generateChallenge: () => `challenge-${queue[0] ?? "missing"}`,
    generateState: () => {
      const state = queue.shift();
      if (state === undefined) throw new Error("state generated too many times");
      return state;
    },
  };
}
