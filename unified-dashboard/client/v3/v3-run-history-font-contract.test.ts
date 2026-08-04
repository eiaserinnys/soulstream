import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = fileURLToPath(new URL("./v3-run-history.css", import.meta.url));

describe("v3 run history font contract", () => {
  it("matches the corresponding v1 SessionItem font sizes", () => {
    const css = readFileSync(CSS_PATH, "utf8");

    expect(css).toMatch(/\.v3-run-open strong\s*{[^}]*font-size:\s*14\.5px/s);
    expect(css).toMatch(/\.v3-run-agent-line\s*{[^}]*font-size:\s*var\(--font-size-xs\)/s);
    expect(css).toMatch(/\.v3-run-open small\s*{[^}]*font-size:\s*var\(--font-size-sm\)/s);
    expect(css).toMatch(/\.v3-run-trailing time\s*{[^}]*font-size:\s*var\(--font-size-xs\)/s);
  });

  it("reserves visible width for the node after adding the model label", () => {
    const css = readFileSync(CSS_PATH, "utf8");

    expect(css).toMatch(/\.v3-run-title-line,\s*\.v3-run-agent-line\s*{[^}]*display:\s*flex[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.v3-run-agent-line span:last-child\s*{[^}]*min-width:\s*6ch/s);
  });

  it("never lets an agent-line item grow into the leftover width", () => {
    // 260804: span:first-child에 flex:1을 주자 에이전트 이름이 남는 폭을 전부
    // 삼켜 모델·노드가 오른쪽 끝으로 밀려났다. 항목은 내용 너비대로 좌측에
    // 붙어 있어야 한다 — grow를 허용하는 어떤 선언도 이 줄에 들어오면 안 된다.
    const css = readFileSync(CSS_PATH, "utf8");
    const agentLineItemRules = [...css.matchAll(/\.v3-run-agent-line span[^{]*{([^}]*)}/gs)]
      .map((match) => match[1]);

    expect(agentLineItemRules.length).toBeGreaterThan(0);
    for (const body of agentLineItemRules) {
      expect(body).not.toMatch(/flex-grow:\s*[1-9]/);
      expect(body).not.toMatch(/flex:\s*[1-9]/);
    }
  });
});
