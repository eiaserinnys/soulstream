import { describe, expect, it } from "vitest";

import {
  toMermaid,
  type ChartNode,
  type ChartSpec,
  type ChartTransition,
} from "../src/statechart/mermaid.js";

function node(
  id: string,
  key: string,
  type: ChartNode["type"],
  extra: Partial<ChartNode> = {},
): ChartNode {
  return { id, key, type, states: {}, on: {}, ...extra };
}

function attach(parent: ChartNode, ...children: ChartNode[]): void {
  for (const child of children) {
    child.parent = parent;
    parent.states[child.key] = child;
  }
}

function on(state: ChartNode, eventType: string, transitions: Array<Partial<ChartTransition>>): void {
  state.on[eventType] = transitions.map((transition) => ({ eventType, source: state, ...transition }));
}

const CLASS_DEFS = [
  "classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2px,color:#cd2834",
  "classDef hole fill:#ffffff,stroke:#9a9a9a,stroke-dasharray:4 3",
];

function cardLikeFixture(): { root: ChartNode; spec: ChartSpec } {
  const alpha = node("alpha", "alpha", "compound", { description: '상태 "알파"' });
  const one = node("alpha.one", "one", "compound");
  const x = node("alpha.one.x", "x", "atomic");
  const y = node("alpha.one.y", "y", "atomic");
  const two = node("alpha.two", "two", "atomic");
  attach(one, x, y);
  attach(alpha, one, two);

  const beta = node("beta", "beta", "parallel");
  const r1 = node("beta.r1", "r1", "compound");
  const a1 = node("beta.r1.a1", "a1", "atomic");
  const a2 = node("beta.r1.a2", "a2", "atomic");
  attach(r1, a1, a2);
  const r2 = node("beta.r2", "r2", "atomic");
  const r3 = node("beta.r3", "r3", "atomic");
  attach(beta, r1, r2, r3);

  const gamma = node("gamma", "gamma", "compound", { description: "닫힌 상자" });
  const inner = node("gamma.inner", "inner", "atomic");
  const inner2 = node("gamma.inner2", "inner2", "atomic");
  attach(gamma, inner, inner2);

  const delta = node("delta", "delta", "compound");
  const d1 = node("delta.d1", "d1", "atomic");
  attach(delta, d1);

  const epsilon = node("epsilon", "epsilon", "atomic", { tags: ["unnamed"] });
  const dotted = node("a.b", "a.b", "atomic");
  const dashed = node("a-b", "a-b", "atomic");

  const root = node("root", "root", "compound");
  attach(root, alpha, beta, gamma, delta, epsilon, dotted, dashed);

  on(alpha, "GO_DOWN", [{ target: [y] }]);
  on(alpha, "HIDE_ME", [{ target: [delta] }]);
  on(x, "GO", [{ target: [y], description: "다음" }]);
  on(two, "TICK", [{ target: [alpha] }]);
  on(a1, "RESUME", [{ target: [alpha], meta: { chartGroup: "resume" } }]);
  on(a1, "JUMP", [{ target: [two] }]);
  on(r2, "SELF", [{ target: [r2] }]);
  on(inner, "INNER", [{ target: [inner2] }]);
  on(d1, "RESUME2", [{ target: [epsilon], meta: { chartGroup: "resume" } }]);
  on(dotted, "PAIR", [{ target: [dashed] }]);
  on(epsilon, "PING", [{}]);

  const spec: ChartSpec = {
    include: ["alpha", "beta", "gamma", "epsilon", "a.b", "a-b"],
    hide: ["delta"],
    collapse: ["gamma"],
    groups: { resume: { from: "beta.r1.a1", to: "alpha.two", label: "다시 시작" } },
    hideEvents: ["TICK"],
    marks: {
      states: ["beta.r1.a1"],
      transitions: [{ source: "alpha.one.x", event: "GO", note: "재진입" }],
    },
    holes: [
      { id: "h1", parent: "alpha.one", label: "한 번도 안 가는 자리", reachable: false },
      {
        id: "g1",
        parent: "beta",
        label: "끊긴 자리",
        reachable: true,
        note: "검증",
        incoming: [{ from: "beta.r2", label: "WAKE" }],
      },
    ],
  };

  return { root, spec };
}

describe("toMermaid", () => {
  it("상자, 화살표, 구멍, 표시를 stateDiagram-v2 글로 그린다", () => {
    const { root, spec } = cardLikeFixture();

    const result = toMermaid(root, spec);

    const expected = [
      "stateDiagram-v2",
      "direction TB",
      ...CLASS_DEFS,
      'state "상태 \'알파\'" as alpha {',
      "    direction TB",
      '    state "one" as alpha_one {',
      "        direction TB",
      '        state "x" as alpha_one_x',
      '        state "y" as alpha_one_y',
      '        state "한 번도 안 가는 자리 *" as hole_h1',
      "        alpha_one_x --> alpha_one_y: 다음 (재진입)",
      "    }",
      '    state "two" as alpha_two',
      "    alpha --> alpha_one_y: GO_DOWN",
      "}",
      'state "beta" as beta {',
      "    direction TB",
      '    state "r1" as beta_r1 {',
      "        direction TB",
      '        state "a1" as beta_r1_a1',
      '        state "a2" as beta_r1_a2',
      "    }",
      '    state "r2" as beta_r2',
      '    state "r3" as beta_r3',
      '    state "끊긴 자리 * (검증)" as hole_g1',
      "    beta_r2 --> beta_r2: SELF",
      "    beta_r2 --> hole_g1: WAKE",
      "}",
      'state "닫힌 상자" as gamma',
      'state "epsilon *" as epsilon',
      'state "a.b" as a_b',
      'state "a-b" as a_b_2',
      "beta_r1_a1 --> alpha_two: 다시 시작",
      "beta_r1_a1 --> alpha_two: JUMP",
      "a_b --> a_b_2: PAIR",
      "class beta_r1_a1 breaks",
      "class hole_h1 hole",
      "class hole_g1 breaks",
    ].join("\n");

    expect(result).toEqual({
      mermaid: expected,
      edgeCount: 7,
      warnings: ["ancestor edge: alpha -> alpha.one.y"],
    });
  });

  it("parallel이 divider면 영역 사이에 --를 넣는다", () => {
    const parallel = node("p", "p", "parallel");
    attach(parallel, node("p.r1", "r1", "atomic"), node("p.r2", "r2", "atomic"));
    const root = node("root", "root", "compound");
    attach(root, parallel);

    const result = toMermaid(root, { include: ["p"], parallel: "divider" });

    const expected = [
      "stateDiagram-v2",
      "direction TB",
      ...CLASS_DEFS,
      'state "p" as p {',
      "    direction TB",
      '    state "r1" as p_r1',
      "    --",
      '    state "r2" as p_r2',
      "}",
    ].join("\n");

    expect(result).toEqual({ mermaid: expected, edgeCount: 0, warnings: [] });
  });

  it("spec의 상태 id가 기계에 없으면 예외를 던진다", () => {
    const root = node("root", "root", "compound");
    attach(root, node("a", "a", "atomic"));

    expect(() => toMermaid(root, { include: ["missing"] })).toThrow(/missing/);
  });

  it("groups에 없는 chartGroup은 예외를 던진다", () => {
    const a = node("a", "a", "atomic");
    const b = node("b", "b", "atomic");
    const root = node("root", "root", "compound");
    attach(root, a, b);
    on(a, "GO", [{ target: [b], meta: { chartGroup: "resume" } }]);

    expect(() => toMermaid(root, { include: ["a", "b"] })).toThrow(/resume/);
  });

  it("화살표가 25개를 넘으면 경고를 남긴다", () => {
    const wrapper = node("m", "m", "compound");
    const states: ChartNode[] = [];
    for (let index = 0; index <= 26; index += 1) {
      states.push(node(`m.s${index}`, `s${index}`, "atomic"));
    }
    attach(wrapper, ...states);
    for (let index = 0; index < 26; index += 1) {
      on(states[index]!, "NEXT", [{ target: [states[index + 1]!] }]);
    }
    const root = node("root", "root", "compound");
    attach(root, wrapper);

    const result = toMermaid(root, { include: ["m"] });

    expect(result.edgeCount).toBe(26);
    expect(result.warnings).toEqual(["too many edges: 26"]);
  });
});
