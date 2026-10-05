import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import { createPersistentJevObserver } from "../../src/context/persistent_jev_observer.js";

const validObservation = (inputId: string) => ({
  input_id: inputId,
  selected: [],
  candidate_counts: {
    turn_summaries: 0,
    cards: 0,
    search_sessions: 0,
    recent_completed_sessions: 0,
  },
  model: "jev-latest",
  latency_ms: 12,
  top_raw_score: 2.65,
});

const validSelectedCandidate = (index = 1) => ({
  kind: "session",
  session_id: `session-${index}`,
  label: "Prior session",
  line: "A relevant summary",
  score: 2,
  raw_score: 2.65,
});

function makeDeps(fetchImpl: typeof fetch) {
  const enqueueEvent = vi.fn(async () => undefined);
  const warn = vi.fn();
  const observer = createPersistentJevObserver({
    orch: { baseUrl: "https://orch.test", headers: { authorization: "Bearer test-only" } },
    persistence: { enqueueEvent } as unknown as Pick<EventPersistence, "enqueueEvent">,
    logger: { warn } as unknown as Pick<Logger, "warn">,
    fetchImpl,
  });
  return { enqueueEvent, warn, observer };
}

describe("createPersistentJevObserver", () => {
  it("sends the remaining budget and records a valid observation without a registration", async () => {
    const inputId = "input-1";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      observation: validObservation(inputId),
    }), { status: 200 }));
    const { enqueueEvent, observer } = makeDeps(fetchImpl as typeof fetch);

    await observer({ sessionId: "session-1", inputId, request: "check old notes" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://orch.test/api/persistent-context/host/evaluate");
    expect(JSON.parse(String(init.body))).toMatchObject({
      args: {
        session_id: "session-1",
        input_id: inputId,
        request: "check old notes",
        budget_ms: expect.any(Number),
      },
    });
    expect(JSON.parse(String(init.body)).args.budget_ms).toBeLessThanOrEqual(3000);
    expect(enqueueEvent).toHaveBeenCalledWith("session-1", expect.objectContaining({
      type: "debug",
      kind: "persistent_jev_candidates",
      observation: validObservation(inputId),
    }));
    expect(enqueueEvent.mock.calls[0]).toHaveLength(2);
  });

  it("records a successful empty selection and skips null", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ observation: validObservation("input-1") }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ observation: null }), { status: 200 }));
    const { enqueueEvent, observer } = makeDeps(fetchImpl as typeof fetch);

    await observer({ sessionId: "session-1", inputId: "input-1", request: "one" });
    await observer({ sessionId: "session-1", inputId: "input-2", request: "two" });

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent.mock.calls[0][1]).toMatchObject({
      kind: "persistent_jev_candidates",
      observation: { selected: [] },
    });
  });

  it("uses the shared wire guard to reject oversized or extended observations", async () => {
    const observation = validObservation("input-1");
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ observation: { ...observation, extra: true } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        observation: { ...observation, selected: Array.from({ length: 6 }, (_, index) => validSelectedCandidate(index)) },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        observation: { ...observation, selected: [{ ...validSelectedCandidate(), extra: true }] },
      }), { status: 200 }));
    const { enqueueEvent, observer } = makeDeps(fetchImpl as typeof fetch);

    await observer({ sessionId: "session-1", inputId: "input-1", request: "extra observation field" });
    await observer({ sessionId: "session-1", inputId: "input-1", request: "too many candidates" });
    await observer({ sessionId: "session-1", inputId: "input-1", request: "extra candidate field" });

    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  it("does not record mismatched, late, failed, or malformed responses", async () => {
    const late = deferred<Response>();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ observation: validObservation("other-input") }), { status: 200 }))
      .mockImplementationOnce(() => late.promise)
      .mockRejectedValueOnce(Object.assign(new Error("network detail"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    const { enqueueEvent, warn, observer } = makeDeps(fetchImpl as typeof fetch);
    const now = vi.spyOn(Date, "now");

    await observer({ sessionId: "session-1", inputId: "input-1", request: "mismatch" });

    now.mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValueOnce(4001);
    const lateResult = observer({ sessionId: "session-1", inputId: "input-2", request: "late" });
    late.resolve(new Response(JSON.stringify({ observation: validObservation("input-2") }), { status: 200 }));
    await lateResult;

    now.mockRestore();
    await observer({ sessionId: "session-1", inputId: "input-3", request: "timeout" });
    await observer({ sessionId: "session-1", inputId: "input-4", request: "malformed" });

    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
    for (const [fields] of warn.mock.calls) {
      expect(fields).toMatchObject({ sessionId: "session-1", failureKind: expect.any(String) });
      expect(JSON.stringify(fields)).not.toContain("network detail");
      expect(JSON.stringify(fields)).not.toContain("request");
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
