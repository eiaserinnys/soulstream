import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateRunnerStateDocument } from "../src/runner/state/runner_charts.js";

const result = generateRunnerStateDocument();
const doc = new URL("../../docs/runners/runner-state.md", import.meta.url);
await mkdir(new URL("../../docs/runners/", import.meta.url), { recursive: true });
await writeFile(doc, result.markdown);

if (process.argv[2]) {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const directory = path.resolve(repositoryRoot, process.argv[2]);
  await mkdir(directory, { recursive: true });
  for (const chart of result.charts) {
    await writeFile(path.join(directory, `${chart.id}.mmd`), `${chart.mermaid}\n`);
  }
}

console.log(result.charts
  .map((chart) => `${chart.id}: ${chart.edgeCount} edges, ${chart.warnings.length} warnings`)
  .join("\n"));
