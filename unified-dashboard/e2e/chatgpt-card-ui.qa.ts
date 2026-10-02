import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {installV3VisualQaRoutes} from './v3-visual-fixtures';
import {widgetHtml} from '../../plugins/chatgpt-card-renderer/src/widget-html';
const phase=process.env.WIDGET_QA_PHASE;
if(phase!=='before'&&phase!=='after')throw Error('WIDGET_QA_PHASE must be before or after');
const output=path.resolve('../../../.local/artifacts/20261002-chatgpt-card-ui-v3');
mkdirSync(output,{recursive:true});
const cards=['review','blocked','running','queued','todo','done','cancelled','unknown'].map((status,index)=>({
 id:`card-${index}`,title:`${status} · 긴 한국어 제목으로 실제 카드 줄바꿈과 본문 공간을 확인합니다`,status,assignee:'로젤린',updatedAt:null,
 preview:index===4?undefined:{kind:index%2?'instruction':'report',text:'마지막 지시와 보고의 실제 본문 발췌입니다. 긴 문장도 카드 안에서 제한된 줄수로 표시됩니다. '.repeat(6)}}));
for(const width of [1440,390]){
 test(`dashboard shared samples ${width}`,async({page})=>{
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await page.addInitScript(()=>{localStorage.setItem('soul-dashboard-theme','dark');localStorage.setItem('ls.webglGlass','0');});
  await installV3VisualQaRoutes(page,{unifiedFolderView:true,timelineEventCount:1});
  await page.goto('/components');
  const sample=page.getByTestId('postit-size-comparison');await expect(sample).toBeVisible({timeout:20000});
  await sample.scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);
  await sample.screenshot({path:path.join(output,`${phase}-dashboard-${width}.png`),animations:'disabled'});
  const metrics=await sample.locator('.v3-postit-card').evaluateAll(nodes=>nodes.map(n=>{
   const el=n as HTMLElement;return {width:el.offsetWidth,height:el.offsetHeight,html:el.outerHTML};}));
  writeFileSync(path.join(output,`${phase}-dashboard-${width}.json`),JSON.stringify(metrics,null,2));
  if(phase==='after'){
   expect(metrics).toEqual(JSON.parse(readFileSync(path.join(output,`before-dashboard-${width}.json`),'utf8')));
   await page.getByTestId('readonly-card-list-sample').screenshot({path:path.join(output,`review-sample-${width}.png`),animations:'disabled'});
  }
 });
 test(`iframe groups and bridge ${width}`,async({page})=>{
  await page.setViewportSize({width,height:1000});await page.clock.install();
  const errors:string[]=[],external:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:4197/qa'))external.push(r.url());});
  await page.route('**/qa',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><body style="margin:0"><iframe title="카드 iframe" style="border:0;width:100%;height:1000px" srcdoc="${widgetHtml.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></iframe><script>
  const frame=document.querySelector('iframe');window.calls=[];const result=()=>({structuredContent:{cards:${JSON.stringify(cards)},total:8,sync:{folderId:'qa',limit:100,refreshSeconds:30,fetchedAt:'2026-10-02T00:00:00Z'}}});
  window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const m=e.data;if(m.method==='ui/initialize')frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:{}},'*');if(m.method==='ui/notifications/initialized')frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result()},'*');if(m.method==='tools/call'){window.calls.push(m);frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:result()},'*');}});</script>`}));
  await page.goto('/qa');const frame=page.frameLocator('iframe');
  await expect(frame.locator('article')).toHaveCount(8);
  if(phase==='after')await page.locator('iframe').evaluate((el:any)=>el.style.height=el.contentDocument.documentElement.scrollHeight+'px');
  await page.screenshot({path:path.join(output,`${phase}-iframe-${width}.png`),fullPage:true,animations:'disabled'});
  if(phase==='after'){
   await expect(frame.locator('[data-card-group]').first()).toHaveAttribute('data-card-group',/./);
   expect(await frame.locator('[data-card-group]').evaluateAll(n=>n.map(el=>el.getAttribute('data-card-group')))).toEqual(['attention','running','queued','draft','completed']);
   await expect(frame.locator('.v3-postit-card button,.v3-postit-card img,[data-slot=status-chip]')).toHaveCount(0);
   await expect(frame.getByText('취소됨',{exact:true})).toBeVisible();await expect(frame.getByText('상태 확인 필요',{exact:true})).toBeVisible();
   await frame.getByRole('combobox',{name:'카드 상태 필터'}).click();await frame.getByRole('option',{name:'검수 대기',exact:true}).click();
   await expect(frame.locator('article')).toHaveCount(2);
   await frame.getByRole('combobox',{name:'카드 상태 필터'}).click();await frame.getByRole('option',{name:'전체',exact:true}).click();
   await expect(frame.locator('article')).toHaveCount(8);
   const geometry=await frame.locator('body').evaluate(()=>{
    const scope=document.querySelector('.v3-detail-scroll')!,header=document.querySelector('header')!,section=document.querySelector('[data-card-group]')!;
    const a=header.getBoundingClientRect(),b=section.getBoundingClientRect();return {padding:getComputedStyle(scope).padding,headerX:a.x,sectionX:b.x,top:a.y,overflow:document.documentElement.scrollWidth>innerWidth,controls:[...document.querySelectorAll('[data-slot="select-trigger"],#refresh')].map(el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return {height:rect.height,top:rect.top,font:style.fontSize};})};});
   expect(geometry.top).toBeGreaterThan(0);expect(Math.abs(geometry.headerX-geometry.sectionX)).toBeLessThanOrEqual(1);expect(geometry.overflow).toBe(false);expect(geometry.controls[0]).toEqual(geometry.controls[1]);
   writeFileSync(path.join(output,`after-iframe-${width}.json`),JSON.stringify(geometry,null,2));
  }
  await frame.getByRole('button',{name:'새로고침',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).calls.length)).toBe(1);
  await page.clock.fastForward(30000);await expect.poll(()=>page.evaluate(()=>(window as any).calls.length)).toBe(2);
  expect(external).toEqual([]);expect(errors).toEqual([]);
 });
}
