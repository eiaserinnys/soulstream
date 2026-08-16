import { describe, expect, it } from "vitest";

import {
  sendMessageToSession,
  type SendMessageToSessionDeps,
} from "../../src/task/session_message_sender.js";

const ORCH = { baseUrl: "http://orch.test", headers: {} };

function silentLogger() {
  // The relay path always warns once about the local failure that caused the
  // fallback; only the missing-verdict warning is under test here.
  const warnings: string[] = [];
  const logger = {
    warn: (_context: Record<string, unknown>, message: string) => {
      warnings.push(message);
    },
  };
  return { warnings, logger: logger as unknown as SendMessageToSessionDeps["logger"] };
}

function verdictWarnings(warnings: string[]): string[] {
  return warnings.filter((message) => message.includes("without a delivery verdict"));
}

function relayingDeps(
  responder: () => Response,
): SendMessageToSessionDeps & { warnings: string[] } {
  const { warnings, logger } = silentLogger();
  return {
    warnings,
    logger,
    orch: ORCH,
    onResume: () => {},
    // Forces the orch relay path: the target session lives on another node.
    taskManager: {
      addIntervention: async () => {
        throw new Error("Task owned by another node: owner=other current=self");
      },
    },
    fetchImpl: async () => responder(),
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("sendMessageToSession relay verdict", () => {
  it("surfaces a delivered verdict from the owning node", async () => {
    const deps = relayingDeps(() => jsonResponse({
      type: "intervene_ack",
      status: "ok",
      outcome: "delivered",
      delivered: true,
    }));

    const result = await sendMessageToSession(deps, {
      targetSessionId: "session-1",
      message: "steer",
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      detail: { relayed: true, delivered: true, outcome: "delivered" },
    });
    expect(verdictWarnings(deps.warnings)).toHaveLength(0);
  });

  it("surfaces a queued verdict with its consumption point", async () => {
    const deps = relayingDeps(() => jsonResponse({
      type: "intervene_ack",
      status: "ok",
      outcome: "queued",
      delivered: false,
      queuePosition: 2,
      consumeWhen: "next_turn",
      reason: "engine_busy",
    }));

    const result = await sendMessageToSession(deps, {
      targetSessionId: "session-1",
      message: "steer",
    });

    // The caller must be able to tell "the agent has it" from "it is waiting
    // behind two others" — collapsing both into ok:true is the defect.
    expect(result).toMatchObject({
      detail: {
        relayed: true,
        delivered: false,
        outcome: "queued",
        queue_position: 2,
        consume_when: "next_turn",
        reason: "engine_busy",
      },
    });
  });

  it("reports an unknown verdict as null rather than inventing one", async () => {
    const deps = relayingDeps(() => jsonResponse({ ok: true }));

    const result = await sendMessageToSession(deps, {
      targetSessionId: "session-1",
      message: "steer",
    });

    expect(result).toMatchObject({ detail: { relayed: true, delivered: null } });
    // Unknown is not failure. Fabricating `false` would make callers re-send an
    // intervention the agent already consumed.
    expect(result).not.toMatchObject({ detail: { delivered: false } });
    expect(verdictWarnings(deps.warnings)).toHaveLength(1);
  });

  it("preserves an explicit unknown verdict from the orchestrator", async () => {
    const deps = relayingDeps(() => jsonResponse({
      type: "intervene_ack",
      status: "ok",
      outcome: "unknown",
      delivered: null,
      consumeWhen: null,
      reason: "verdict_unknown",
    }));

    const result = await sendMessageToSession(deps, {
      targetSessionId: "session-1",
      message: "steer",
    });

    expect(result).toMatchObject({
      detail: {
        relayed: true,
        delivered: null,
        outcome: "unknown",
        reason: "verdict_unknown",
        consume_when: null,
      },
    });
    expect(verdictWarnings(deps.warnings)).toHaveLength(1);
  });

  it("treats an unreadable body as unknown, not as a relay failure", async () => {
    const deps = relayingDeps(() => new Response("not json", { status: 200 }));

    const result = await sendMessageToSession(deps, {
      targetSessionId: "session-1",
      message: "steer",
    });

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ detail: { relayed: true, delivered: null } });
  });

  it("still fails loudly when orch rejects the relay", async () => {
    const deps = relayingDeps(() => new Response("nope", { status: 502 }));

    const result = await sendMessageToSession(deps, {
      targetSessionId: "session-1",
      message: "steer",
    });

    expect(result.ok).toBe(false);
  });

  it("leaves the local delivery path untouched", async () => {
    const { logger } = silentLogger();
    const result = await sendMessageToSession({
      logger,
      orch: ORCH,
      onResume: () => {},
      taskManager: { addIntervention: async () => ({ delivered: true as const }) },
      fetchImpl: async () => { throw new Error("relay must not be attempted"); },
    } as unknown as SendMessageToSessionDeps, {
      targetSessionId: "session-1",
      message: "steer",
    });

    expect(result).toEqual({ ok: true, detail: { delivered: true } });
  });
});
