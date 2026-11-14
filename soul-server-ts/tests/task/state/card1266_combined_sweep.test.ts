/**
 * 카드 #1266 U5c: 카드 #1218 합의의 합친 훑기를 TS 시험으로 옮겼다.
 * 노드와 러너 걸음은 제품 판정 함수로 다음 구성을 고른다(tests/task/state/combined_sweep/).
 * 약속 위반이 나오면 단언 메시지에 위반 구성 하나의 최단 경로가 실린다.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  PRODUCT,
  REVERT_OVERLAYS,
  modelWorktreeBusyReap,
  withCache,
  type CachedDecisions,
  type DecisionName,
  type ProductDecisions,
} from "./combined_sweep/product_decisions.js";
import type { WorldOptions } from "./combined_sweep/world_context.js";
import {
  LIVENESS,
  SAFETY,
  STEPS_DISABLED_BY_FIX,
  STEP_IDS,
  analyze,
  counts,
  type PromiseResult,
  type SweepResult,
} from "./combined_sweep/sweep.js";

/** 한 시험의 시간 한도다(선례 orch-server-ts/tests/card-machine-promises.test.ts). */
const TIMEOUT_MS = 300_000;
/** 길이 2와 1에서 세계가 비어 있지 않음을 보이는 아래 한계다. 모형은 108,500 구성이다. */
const MIN_CONFIGS = 100_000;

function options(decisions: ProductDecisions, extra: Partial<WorldOptions> = {}): WorldOptions {
  return {
    k: 2,
    k2: 1,
    codex: true,
    envOff: new Set(),
    settlePending: true,
    requeue: true,
    decisions,
    ...extra,
  };
}

function sweep(decisions: ProductDecisions, extra: Partial<WorldOptions> = {}): SweepResult {
  return analyze(options(withCache(decisions).decisions, extra));
}

const why = (r: PromiseResult): string => (r.example ? `shortest path:\n  ${r.example.join("\n  ")}` : "");

describe("card #1266 U5c combined sweep (lengths 2 and 1)", () => {
  let cache: CachedDecisions;
  let product: SweepResult;
  let withoutPermReject: SweepResult;

  beforeAll(() => {
    cache = withCache(PRODUCT);
    product = analyze(options(cache.decisions));
    withoutPermReject = sweep(PRODUCT, { envOff: new Set(["J35"]) });
    console.log(JSON.stringify({
      product: counts(product),
      productMs: product.elapsedMs,
      p15WithoutPermReject: [product.p15WithoutPermReject, product.p15FairWithoutPermReject],
      withoutPermReject: counts(withoutPermReject),
      withoutPermRejectMs: withoutPermReject.elapsedMs,
      cache: cache.stats(),
    }));
  }, TIMEOUT_MS);

  it("explores a non-empty world, takes every step and calls every product decision", () => {
    expect(product.configs).toBeGreaterThanOrEqual(MIN_CONFIGS);
    const unused = STEP_IDS.filter((id) => product.used[id] === 0);
    expect(unused).toEqual(Object.keys(STEPS_DISABLED_BY_FIX));
    const stats = cache.stats();
    for (const name of Object.keys(PRODUCT) as DecisionName[]) {
      expect(stats[name]?.calls ?? 0, name).toBeGreaterThan(0);
    }
  });

  it("keeps the safety promises 2, 4, 4b, 5 and both step counts at zero", () => {
    for (const id of Object.keys(SAFETY)) {
      expect(product.safety[id]!.count, `safety ${id}\n${why(product.safety[id]!)}`).toBe(0);
    }
    expect(product.steps.dupHandover).toBe(0);
    expect(product.steps.vanishedStop).toBe(0);
  });

  it.each(["7", "9", "12", "13", "14"])("keeps the path promise %s", (id) => {
    expect(product.path[id]!.count, `path ${id}: ${LIVENESS[id]![0]}\n${why(product.path[id]!)}`).toBe(0);
  });

  it("leaves promise 15 only in configurations reached through a permanent rejection", () => {
    expect(product.path["15"]!.count).toBeGreaterThan(0);
    expect(product.p15WithoutPermReject, "promise 15 violations reachable without J35").toBe(0);
    expect(product.p15FairWithoutPermReject, "promise 15 fair violations reachable without J35").toBe(0);
  });

  it("keeps every promise once the permanent rejection step is off", () => {
    for (const id of Object.keys(LIVENESS)) {
      const r = withoutPermReject.path[id]!;
      expect(r.count, `path ${id} without J35\n${why(r)}`).toBe(0);
    }
  });

  it("leaves only promise 15 under the fair judgement", () => {
    for (const id of ["7", "9", "12", "13", "14"]) {
      expect(product.fair[id]!.count, `fair ${id}\n${why(product.fair[id]!)}`).toBe(0);
    }
    expect(product.fair["15"]!.count).toBeGreaterThan(0);
  });
});

describe("card #1266 U5c world port against the hand model", () => {
  it("reproduces the model numbers when the worktree-busy adopt rejection reaps as in M", () => {
    // R/fable_r3_results.jsonl 12줄과 14줄(셋째 판의 안, 길이 2와 1)이다.
    const model = sweep(modelWorktreeBusyReap(PRODUCT));
    expect(model.configs).toBe(108_500);
    expect(counts(model)).toMatchObject({
      "safety 2": 0, "safety 4": 0, "safety 4b": 0, "safety 5": 0,
      "path 7": 0, "path 9": 0, "path 12": 0, "path 13": 0, "path 14": 0, "path 15": 1_210,
      "fair 7": 0, "fair 9": 0, "fair 12": 0, "fair 13": 0, "fair 14": 0, "fair 15": 1_222,
      dupHandover: 0, vanishedStop: 0,
    });
    const off = sweep(modelWorktreeBusyReap(PRODUCT), { envOff: new Set(["J35"]) });
    expect(off.configs).toBe(76_109);
    expect(Object.values(off.path).map((r) => r.count)).toEqual([0, 0, 0, 0, 0, 0]);
  }, TIMEOUT_MS);
});

describe("card #1266 U5c revert tests: old node behaviour brings violations back", () => {
  let baseline: Record<string, number>;

  beforeAll(() => {
    baseline = counts(sweep(PRODUCT));
  }, TIMEOUT_MS);

  const cases: readonly (readonly [string, string, () => SweepResult])[] = [
    ["I3 completion settlement pending (world switch)", "path 9", () => sweep(PRODUCT, { settlePending: false })],
    ["I2 permanent rejection cell (overlay)", "path 7", () => sweep(REVERT_OVERLAYS.dlcell(PRODUCT))],
    ["I4 reaping on the rejection reason (overlay)", "path 13", () => sweep(REVERT_OVERLAYS.reap(PRODUCT))],
    ["I4 reaping on the rejection reason (overlay)", "path 14", () => sweep(REVERT_OVERLAYS.reap(PRODUCT))],
    ["I4 asking a handed instruction by number (overlay)", "dupHandover", () => sweep(REVERT_OVERLAYS.handover(PRODUCT))],
    ["I6 codex queued instruction recovery (world switch)", "path 13", () => sweep(PRODUCT, { requeue: false })],
    ["candidate D stop during a handoff (overlay)", "vanishedStop", () => sweep(REVERT_OVERLAYS.stop(PRODUCT))],
  ];

  it.each(cases)("%s raises %s above the product", (_name, metric, run) => {
    const reverted = counts(run());
    console.log(JSON.stringify({ revert: _name, metric, product: baseline[metric], reverted: reverted[metric] }));
    expect(reverted[metric]).toBeGreaterThan(0);
    expect(reverted[metric]).toBeGreaterThan(baseline[metric]!);
  }, TIMEOUT_MS);
});

describe("card #1266 U5c decision cache", () => {
  it("returns what the product decision returns for every cached input", () => {
    const cache = withCache(PRODUCT);
    analyze(options(cache.decisions, { k: 1 }));
    const entries = cache.entries();
    expect(entries.length).toBeGreaterThan(0);
    for (const { name, args, result } of entries) {
      const fresh = (PRODUCT[name] as (...a: unknown[]) => unknown)(...args);
      expect(fresh, `${name}(${JSON.stringify(args)})`).toEqual(result);
    }
  });

  it("gives the same sweep with and without the cache", () => {
    const cached = analyze(options(withCache(PRODUCT).decisions, { k: 1 }));
    const raw = analyze(options(PRODUCT, { k: 1 }));
    console.log(JSON.stringify({ cachedMs: cached.elapsedMs, rawMs: raw.elapsedMs }));
    expect(counts(cached)).toEqual(counts(raw));
    expect(cached.used).toEqual(raw.used);
  }, TIMEOUT_MS);
});
