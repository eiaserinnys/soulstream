import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateNodeStateDocument } from "../src/task/state/node_charts.js";

const result = generateNodeStateDocument();
const doc = new URL("../../docs/nodes/node-state.md", import.meta.url);
await mkdir(new URL("../../docs/nodes/", import.meta.url), { recursive: true });
await writeFile(doc, result.markdown);

// 그림 파일은 항상 docs/nodes/generated에 쓴다. 인자를 주면 그 폴더에도 쓴다.
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const directories = [path.join(repositoryRoot, "docs/nodes/generated")];
if (process.argv[2]) directories.push(path.resolve(repositoryRoot, process.argv[2]));
for (const directory of directories) {
  await mkdir(directory, { recursive: true });
  for (const chart of result.charts) {
    await writeFile(path.join(directory, `${chart.id}.mmd`), `${chart.mermaid}\n`);
  }
}

console.log(result.charts
  .map((chart) => `${chart.id}: ${chart.edgeCount} edges, ${chart.warnings.length} warnings`)
  .join("\n"));
