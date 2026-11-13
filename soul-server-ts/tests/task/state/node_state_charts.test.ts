import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { generateNodeStateDocument } from "../../../src/task/state/node_charts.js";
import { nodeGuessCells } from "../../../src/task/state/node_guess_cells.js";

describe("node state charts", () => {
  it("regenerates the committed document and charts without a diff", async () => {
    const result = generateNodeStateDocument();

    expect(result.markdown).toBe(await readFile(
      new URL("../../../../docs/nodes/node-state.md", import.meta.url),
      "utf8",
    ));
    expect(result.charts.length).toBeGreaterThan(0);
    for (const chart of result.charts) {
      expect(chart.warnings).toEqual([]);
      expect(`${chart.mermaid}\n`).toBe(await readFile(
        new URL(`../../../../docs/nodes/generated/${chart.id}.mmd`, import.meta.url),
        "utf8",
      ));
    }
    expect(result.markdown).toContain(
      "corepack pnpm@10.32.1 --dir soul-server-ts exec tsx scripts/node-state-charts.ts",
    );
  }, 300_000);

  it("names the closing unit of every one of the twenty guessed cells", () => {
    const cells = nodeGuessCells();
    expect(cells).toHaveLength(20);
    expect(new Set(cells.map((cell) => cell.no)).size).toBe(20);
    for (const cell of cells) {
      expect(["종료 경로", "지시 경로", "멈춤"]).toContain(cell.unit);
      expect(cell.current.length).toBeGreaterThan(0);
    }
    expect(cells.filter((cell) => cell.oldTable === "C1")).toHaveLength(7);
    expect(cells.filter((cell) => cell.oldTable === "C2")).toHaveLength(11);
    expect(cells.filter((cell) => cell.oldTable === "T3")).toHaveLength(2);
    const document = generateNodeStateDocument().markdown;
    for (const cell of cells) {
      expect(document).toContain(`| ${cell.no} | ${cell.oldTable} |`);
    }
  });

  it("does not let a stop that waited on a handoff return without a disposition", () => {
    const handoffStop = nodeGuessCells().find(
      (cell) => cell.request === "stop" && cell.pending === "러너에 넘기고 결과를 기다림",
    );
    expect(handoffStop?.current).toBe("넘기기가 끝난 뒤 보통 멈춤 길로");
    expect(handoffStop?.unit).toBe("멈춤");
  });
});
