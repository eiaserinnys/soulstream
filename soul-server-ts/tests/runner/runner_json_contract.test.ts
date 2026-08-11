import { describe, expect, it } from "vitest";

import { assertRunnerJsonValue } from "../../src/runner/runner_json_contract.js";

describe("runner JSON contract graph handling", () => {
  it("accepts shared acyclic values that JSON.stringify can duplicate", () => {
    const shared = { content: "same value" };
    expect(() => assertRunnerJsonValue({ left: shared, right: shared })).not.toThrow();
  });

  it("still rejects a true ancestor cycle", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertRunnerJsonValue(cyclic)).toThrow("cyclic object references");
  });
});
