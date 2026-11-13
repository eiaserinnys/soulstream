import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateSessionStateDocument, sessionPromisesJson } from "../src/session/state/session_state_charts.js";
const result=generateSessionStateDocument();
for(const chart of result.charts) if(chart.warnings.length) throw new Error(`${chart.id}: ${chart.warnings.join(", ")}`);
const doc=new URL("../../docs/sessions/session-state.md",import.meta.url);
await mkdir(new URL("../../docs/sessions/",import.meta.url),{recursive:true});
await writeFile(doc,result.markdown);
if(process.argv[2]) {
  const directory=path.resolve(process.argv[2]);await mkdir(directory,{recursive:true});
  for(const chart of result.charts)await writeFile(path.join(directory,`${chart.id}.mmd`),chart.mermaid+"\n");
  await writeFile(path.join(directory,"session-promises.json"),sessionPromisesJson(result.report));
}
console.log(result.charts.map(c=>`${c.id}: ${c.edgeCount} edges, ${c.warnings.length} warnings`).join("\n"));
