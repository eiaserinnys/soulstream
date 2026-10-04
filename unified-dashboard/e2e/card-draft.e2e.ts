import {test,expect,type Page} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {installV3VisualQaRoutes} from './v3-visual-fixtures';
import {reviewCard} from '../client/v3/components-review-fixtures';
const output=path.resolve('../../../.local/artifacts/20261004-card-draft');
const phase=process.env.CARD_DRAFT_PHASE??'after';
const capture=async(page:Page,name:string)=>{mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${phase}-${name}.png`),animations:'disabled'});};
for(const width of [1280,390])test(`draft and cancelled lane ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.emulateMedia({reducedMotion:'reduce'});
 const cards=[{...reviewCard,id:'cancelled',title:'취소한 카드',status:'cancelled' as const}];
 const creates:any[]=[],writes:any[]=[],executions:any[]=[];
 await page.addInitScript(()=>{localStorage.setItem('ls.webglGlass','0');Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});});
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:cards,successionPickerRuns:true});
 await page.route(/\/api\/cards(?:\?.*)?$/,async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{cards:new URL(route.request().url()).searchParams.get('status')==='done'?[]:cards}});
  const body=route.request().postDataJSON();creates.push(body);
  const card={...reviewCard,...body,id:'draft',status:'todo' as const,assigneeKind:body.assignee?.kind??null,assigneeAgentId:body.assignee?.agentId??null,assigneeSessionId:null};cards.push(card);
  return route.fulfill({status:201,json:{card}});
 });
 await page.route('**/api/cards/*/**',async route=>{
  const parts=new URL(route.request().url()).pathname.split('/'),card=cards.find(c=>c.id===parts[3])!;
  const body=route.request().postDataJSON();
  if(parts[4]==='execution-settings'){Object.assign(card,{nodeId:body.nodeId,assigneeAgentId:body.agentId,modelPreset:body.modelPreset,version:card.version+1});writes.push(body);return route.fulfill({json:{card}});}
  if(parts[4]==='execute'){executions.push(body);Object.assign(card,{status:'running',assigneeKind:'session',assigneeSessionId:'owner',version:card.version+1});return route.fulfill({json:{card,execution:{requestId:'execution',sessionId:'owner',state:'started'}}});}
  if(parts[4]==='status'){writes.push(body);Object.assign(card,{status:body.status,version:card.version+1});}
  return route.fulfill({json:{card,reports:[],questions:[],sessions:[],comments:[]}});
 });
 await page.route(/\/api\/cards\/[^/?]+$/,route=>{const card=cards.find(c=>c.id===new URL(route.request().url()).pathname.split('/')[3]);return route.fulfill({json:{card,reports:[],questions:[],sessions:[],comments:[]}});});
 await page.goto('/');const home=page.getByTestId('card-home');await expect(home).toBeVisible();
 await home.getByRole('button',{name:'새 카드',exact:true}).click();const dialog=page.getByRole('dialog',{name:'새 카드',exact:true});await expect(dialog).toBeVisible();
 await capture(page,`form-${width}`);
 await dialog.getByRole('textbox',{name:'카드 제목'}).fill('실행 대상 없이 저장한 카드');
 await dialog.getByRole('button',{name:'폴더 선택',exact:true}).click();await page.locator('.v3-card-folder-picker').getByRole('tab',{name:'전체',exact:true}).click();await page.locator('.v3-card-folder-picker').getByRole('button',{name:'소울스트림',exact:true}).click();
 const metrics=await dialog.evaluate(el=>{const box=(s:string)=>{const r=el.querySelector(s)!.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};};return {popup:el.getBoundingClientRect().toJSON(),title:box('[aria-label="카드 제목"]'),request:box('[aria-label="요청 원문"]'),font:getComputedStyle(el.querySelector('[aria-label="카드 제목"]')!).fontSize};});
 await capture(page,`filled-${width}`);writeFileSync(path.join(output,`${phase}-metrics-${width}.json`),JSON.stringify(metrics,null,2));
 if(phase==='before')return;
 await expect(dialog.getByRole('button',{name:'카드 저장'})).toBeEnabled();await dialog.getByRole('button',{name:'카드 저장'}).click();await expect(dialog).toHaveCount(0);
 expect(creates).toHaveLength(1);expect(creates[0]).toMatchObject({request:'',nodeId:null,assignee:null,modelPreset:null,queue:false});expect(executions).toHaveLength(0);
 const draft=home.locator('[data-card-id="draft"]');await expect(draft).toBeVisible();await draft.click({button:'right'});await page.locator('[data-card-status-picker]').getByRole('button',{name:'실행 중',exact:true}).click();
 const settings=page.getByRole('dialog',{name:'카드 실행 설정',exact:true});await expect(settings).toBeVisible();await expect(settings.getByRole('button',{name:'카드 설정 저장'})).toBeEnabled();await capture(page,`execution-chooser-${width}`);
 await settings.getByRole('button',{name:'카드 설정 저장'}).click();await expect(settings).toHaveCount(0);expect(writes).toHaveLength(1);expect(executions).toHaveLength(1);await expect(page.getByTestId('card-detail')).toHaveCount(0);await capture(page,`started-${width}`);
 const board=home.locator('.v3-card-board');await expect(board.locator('[data-board-column="cancelled"]')).toHaveCount(0);
 await home.getByRole('switch',{name:'완료·취소 숨김'}).click();await expect(board.locator('[data-board-column="cancelled"]')).toHaveCount(1);
 await board.locator('[data-board-column="cancelled"]').scrollIntoViewIfNeeded();await capture(page,`cancelled-${width}`);
 const laneMetrics=await board.evaluate(el=>['todo','queued','cancelled'].map(status=>{const lane=el.querySelector(`[data-board-column="${status}"]`)!;const r=lane.getBoundingClientRect();return {status,width:r.width,top:r.top,headingTop:lane.querySelector('h3')!.getBoundingClientRect().top};}));
 expect(Math.max(...laneMetrics.map(m=>m.width))-Math.min(...laneMetrics.map(m=>m.width))).toBeLessThanOrEqual(1);expect(Math.max(...laneMetrics.map(m=>m.top))-Math.min(...laneMetrics.map(m=>m.top))).toBeLessThanOrEqual(1);
 const cancelled=board.locator('[data-card-id="cancelled"]');await cancelled.click({button:'right'});await page.locator('[data-card-status-picker]').getByRole('button',{name:'드래프트',exact:true}).click();await expect(board.locator('[data-board-column="todo"] [data-card-id="cancelled"]')).toHaveCount(1);expect(executions).toHaveLength(1);
 await home.getByRole('switch',{name:'완료·취소 숨김'}).click();await expect(board.locator('[data-board-column="done"]')).toHaveCount(0);await expect(board.locator('[data-board-column="cancelled"]')).toHaveCount(0);
 await capture(page,`hidden-${width}`);
 await home.getByRole('button',{name:'새 카드',exact:true}).click();await expect(page.getByRole('dialog',{name:'새 카드',exact:true})).toBeVisible();await page.getByRole('dialog',{name:'새 카드',exact:true}).getByRole('button',{name:'취소',exact:true}).click();await expect(page.getByRole('dialog',{name:'새 카드',exact:true})).toHaveCount(0);expect(creates).toHaveLength(1);
 writeFileSync(path.join(output,`contract-${width}.json`),JSON.stringify({creates,writes,executions,laneMetrics,productionWrites:0},null,2));
});
