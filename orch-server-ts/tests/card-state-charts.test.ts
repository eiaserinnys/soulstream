import { readFile } from "node:fs/promises";
import { expect,it } from "vitest";
import { generateCardStateDocument } from "../src/cards/state/card_charts.js";
it("커밋된 카드 그림 문서는 정의에서 다시 뽑은 글과 같다",async()=>{
  const result=generateCardStateDocument();
  expect(result.markdown).toBe(await readFile(new URL("../../docs/cards/card-state.md",import.meta.url),"utf8"));
  for(const chart of result.charts) {
    expect(chart.warnings).toEqual([]);
    expect(chart.edgeCount).toBeLessThanOrEqual(25);
  }
  expect(result.charts[0]!.mermaid).not.toContain("card --> card:");
  expect(result.charts[2]!.mermaid).not.toContain("hole_holeOrphan");
  expect(result.charts[2]!.mermaid).not.toContain("class qOrphan breaks");
  expect(result.charts[2]!.events).toContain("WITHDRAW_AUTHOR");
  expect(result.charts[4]!.mermaid).toContain('as card_dismissed {');
  expect(result.charts[4]!.mermaid).not.toContain('as card_cardEntry {');
  expect(result.charts[4]!.mermaid).not.toContain('as card_questionEntry {');
},180000);
