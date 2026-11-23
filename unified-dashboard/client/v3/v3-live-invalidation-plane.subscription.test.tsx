// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  invalidateV3,
  resetV3InvalidationForTest,
  useV3InvalidationKey,
  useV3PlannerInvalidationKeys,
  type V3InvalidationSource,
  type V3PlannerInvalidationKeys,
} from "./v3-live-invalidation-plane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetV3InvalidationForTest();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderProbe(sources: readonly V3InvalidationSource[]) {
  const state = { renders: 0, value: -1 };
  function Probe(): null {
    state.renders += 1;
    state.value = useV3InvalidationKey(sources);
    return null;
  }
  act(() => root.render(<Probe />));
  expect(state.renders).toBe(1);
  return state;
}

function renderPlannerProbe() {
  const state = { renders: 0, value: null as V3PlannerInvalidationKeys | null };
  function Probe(): null {
    state.renders += 1;
    state.value = useV3PlannerInvalidationKeys();
    return null;
  }
  act(() => root.render(<Probe />));
  expect(state.renders).toBe(1);
  return state;
}

describe("v3 invalidation subscriptions", () => {
  it("does not re-render key subscribers for 100 events in unrelated sources", () => {
    const probe = renderProbe(["session_updated", "catalog"]);

    for (let index = 0; index < 100; index += 1) {
      act(() => invalidateV3("card"));
    }

    expect(probe.renders).toBe(1);
    expect(probe.value).toBe(0);
  });

  it("does not re-render planner subscribers for 100 session_updated events", () => {
    const probe = renderPlannerProbe();

    for (let index = 0; index < 100; index += 1) {
      act(() => invalidateV3("session_updated"));
    }

    expect(probe.renders).toBe(1);
  });

  it("returns the same planner key object while all five values are unchanged", () => {
    const probe = renderPlannerProbe();
    const initial = probe.value;

    act(() => invalidateV3("session_updated"));
    act(() => invalidateV3("catalog"));
    act(() => invalidateV3("custom_view"));

    expect(probe.renders).toBe(1);
    expect(probe.value).toBe(initial);
  });

  it("re-renders key subscribers exactly once per relevant session_updated broadcast", () => {
    const probe = renderProbe(["session_updated"]);

    act(() => invalidateV3("session_updated"));
    expect(probe.renders).toBe(2);
    expect(probe.value).toBe(1);

    act(() => invalidateV3("session_updated"));
    act(() => invalidateV3("session_updated"));
    expect(probe.renders).toBe(4);
    expect(probe.value).toBe(3);
  });

  it("re-renders planner subscribers once per relevant collection event", () => {
    const probe = renderPlannerProbe();

    act(() => {
      invalidateV3("session_created");
    });

    expect(probe.renders).toBe(2);
    expect(probe.value).toEqual({
      daily: 1,
      project: 1,
      starred: 1,
      runHistory: 1,
      pageDetail: 0,
    });
  });

  it("updates replay subscribers synchronously inside flushSync", () => {
    const probe = renderProbe(["replay"]);

    act(() => {
      flushSync(() => invalidateV3("replay"));
      expect(probe.value).toBe(1);
      expect(probe.renders).toBe(2);
    });
  });

  it("updates planner subscribers synchronously inside flushSync for replay recovery", () => {
    const probe = renderPlannerProbe();
    const initial = probe.value!;

    act(() => {
      flushSync(() => invalidateV3("replay"));
      expect(probe.value!.pageDetail).toBe(initial.pageDetail + 1);
      expect(probe.value!.daily).toBe(initial.daily + 1);
    });
  });
});
