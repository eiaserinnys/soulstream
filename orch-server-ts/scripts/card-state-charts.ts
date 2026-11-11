import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateCardStateDocument } from "../src/cards/state/card_charts.js";
const result=generateCardStateDocument();
for(const chart of result.charts) if(chart.warnings.length) throw new Error(`${chart.id}: ${chart.warnings.join(", ")}`);
const doc=new URL("../../docs/cards/card-state.md",import.meta.url);
await mkdir(new URL("../../docs/cards/",import.meta.url),{recursive:true});
await writeFile(doc,result.markdown);
if(process.argv[2]) {
  const directory=path.resolve(process.argv[2]);await mkdir(directory,{recursive:true});
  for(const chart of result.charts)await writeFile(path.join(directory,`${chart.id}.mmd`),chart.mermaid+"\n");
  const {report}=result;
  await writeFile(path.join(directory,"promises.json"),JSON.stringify({configurationCount:report.configurationCount,definitionCount:report.definitionCount,promises:[report.promises[0],report.cardEntryPromise,...report.promises.slice(1)],holes:report.holes,marks:report.marks},null,2)+"\n");
}
console.log(result.charts.map(c=>`${c.id}: ${c.edgeCount} edges, ${c.warnings.length} warnings`).join("\n"));
