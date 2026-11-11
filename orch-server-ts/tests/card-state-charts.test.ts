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
},180000);
