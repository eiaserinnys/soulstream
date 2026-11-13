import { readFile } from 'node:fs/promises';
import { expect,it } from 'vitest';
import {
 generateSessionStateDocument,
 sessionPromisesJson,
} from '../src/session/state/session_state_charts.js';
it('regenerates the committed session decision document and charts without a diff',async()=>{
 const result=generateSessionStateDocument();
 expect(result.markdown).toBe(await readFile(new URL('../../docs/sessions/session-state.md',import.meta.url),'utf8'));
 for(const chart of result.charts){
 expect(chart.warnings).toEqual([]);
 expect(chart.edgeCount).toBeLessThanOrEqual(25);
 expect(chart.mermaid+'\n').toBe(await readFile(new URL(`../../docs/sessions/generated/${chart.id}.mmd`,import.meta.url),'utf8'));
 }
 expect(sessionPromisesJson(result.report)).toBe(
 await readFile(new URL('../../docs/sessions/generated/session-promises.json',import.meta.url),'utf8'),
 );
 expect(result.charts.map(chart=>chart.id)).toEqual(['01-status','02-termination','03-review','04-reservation']);
 expect(result.markdown).toContain('## 결정표');
 expect(result.markdown).toContain('## 거절 사유');
 expect(result.markdown).toContain('파일 80개');
 expect(result.markdown).not.toContain('undefined');
},300000);
