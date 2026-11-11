import { readFile } from 'node:fs/promises';
import { expect,it } from 'vitest';
import { generateCardStateDocument } from '../src/cards/state/card_charts.js';
it('regenerates the committed decision charts, board table and permissions without a diff',async()=>{
 const result=generateCardStateDocument();
 expect(result.markdown).toBe(await readFile(new URL('../../docs/cards/card-state.md',import.meta.url),'utf8'));
 for(const chart of result.charts){
 expect(chart.warnings).toEqual([]);
 expect(chart.mermaid+'\n').toBe(await readFile(new URL(`../../docs/cards/generated/${chart.id}.mmd`,import.meta.url),'utf8'));
 }
 expect(result.markdown).toContain('주체 관계별 권한');
 expect(result.markdown).toContain('판에 오르는 장');
 expect(result.charts[0]!.mermaid).not.toContain('originalLive');
},300000);
