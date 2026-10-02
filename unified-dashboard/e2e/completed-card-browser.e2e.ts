import {test,expect,type Page} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {installV3VisualQaRoutes} from './v3-visual-fixtures';
import {reviewCard,reviewDetail,reviewTitle} from '../client/v3/components-review-fixtures';
import {DEFAULT_USER_PREFERENCES} from '../../packages/soul-ui/src/lib/user-preferences';
const output=path.resolve('../../../.local/artifacts/20261002-completed-card-browser');
const baseline=process.env.COMPLETED_BASELINE==='1';
async function fixture(page:Page){
 const now=Date.now(),active=['todo','queued','running','blocked','review'].map((status,index)=>({...reviewCard,id:`active-${index}`,folderId:'folder-amber',status:status as typeof reviewCard.status,title:reviewTitle}));
 const done=Array.from({length:1000},(_,index)=>({...reviewCard,id:`done-${String(index).padStart(4,'0')}`,folderId:'folder-amber',status:'done' as const,
  title:index%10===0?`검색 ${index} ${reviewTitle}`:`완료 카드 ${index}`,request:'Needle 요청',completedAt:new Date(now-index*10*60*1000).toISOString()}));
 const requests:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{localStorage.setItem('ls.webglGlass','0');Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});});
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,postitCards:active});
 await page.route('**/api/auth/config',route=>route.fulfill({json:{authEnabled:true,devModeEnabled:false}}));
 await page.route('**/api/auth/status',route=>route.fulfill({json:{authenticated:true,user:{email:'completed@example.test',name:'검수'}}}));
 await page.route('**/api/user/preferences',route=>route.fulfill({json:{email:'completed@example.test',preferences:{...DEFAULT_USER_PREFERENCES,chatFontSize:17},hasBackground:false}}));
 page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))requests.push(request.url());});
 await page.route(/\/api\/cards(?:\?.*)?$/,route=>{
  const query=new URL(route.request().url()).searchParams;
  if(query.get('status')!=='done')return route.fulfill({json:{cards:query.get('includeCompleted')==='false'?active:[...active,...done.slice(0,1)]}});
  const filtered=done.filter(card=>(!query.get('folderId')||card.folderId===query.get('folderId'))&&(!query.get('completedFrom')||card.completedAt>=query.get('completedFrom')!)&&(!query.get('completedBefore')||card.completedAt<query.get('completedBefore')!)&&`${card.title} ${card.request}`.toLowerCase().includes((query.get('q')??'').toLowerCase()));
  const offset=Number(query.get('cursor')??0),limit=Number(query.get('limit')??60);
  return route.fulfill({json:{cards:filtered.slice(offset,offset+limit),nextCursor:offset+limit<filtered.length?String(offset+limit):null}});
 });
 await page.route(/\/api\/cards\/active-\d$/,route=>{const card=active.find(card=>route.request().url().endsWith(card.id))!;return route.fulfill({json:{...reviewDetail,card}});});
 return {requests,errors};
}
const capture=async(page:Page,name:string)=>{mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,`${baseline?'before':'after'}-${name}.png`),animations:'disabled'});};
for(const width of [390,1440])test(`web home/folder/expanded/regular/gallery ${width}`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.emulateMedia({reducedMotion:'reduce'});const state=await fixture(page);
 await page.goto('/');const home=page.getByTestId('card-home');await expect(home).toBeVisible();await expect(home.locator('[data-card-status=todo]').first()).toBeVisible();
 await capture(page,`web-home-${width}`);
 if(baseline){await page.goto('/components');await page.locator('#components-board').scrollIntoViewIfNeeded();await capture(page,`web-gallery-${width}`);await page.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();await expect(page.getByTestId('card-detail')).toBeVisible();await capture(page,`web-detail-tabs-${width}`);return;}
 const completionRequests=()=>state.requests.filter(url=>new URL(url).searchParams.get('status')==='done');
 expect(completionRequests()).toHaveLength(0);await expect(home.locator('[data-board-column=done]')).toHaveCount(0);
 await home.getByRole('switch',{name:'완료 숨김'}).click();const board=home.locator('.v3-card-board');
 await board.evaluate(node=>{node.scrollLeft=node.scrollWidth;});const lane=home.locator('[data-board-column=done]');
 await expect(lane.locator('[data-card-status=done]').first()).toBeVisible();
 const metrics=await lane.evaluate(node=>({width:node.getBoundingClientRect().width,mounted:node.querySelectorAll('[data-card-status=done]').length,
  columns:getComputedStyle(node.querySelector('.v3-completed-grid')!).gridTemplateColumns.split(' ').length,
  viewport:node.parentElement!.clientWidth-parseFloat(getComputedStyle(node.parentElement!).paddingLeft)-parseFloat(getComputedStyle(node.parentElement!).paddingRight),gap:parseFloat(getComputedStyle(node.querySelector('.v3-completed-grid')!).columnGap),inset:parseFloat(getComputedStyle(node.querySelector('.v3-completed-viewport')!).paddingLeft),
  paper:parseFloat(getComputedStyle(node.querySelector('.v3-postit-card')!).width)}));
 expect(Math.abs(metrics.width-(metrics.columns*metrics.paper+(metrics.columns-1)*metrics.gap+2*metrics.inset))).toBeLessThanOrEqual(1);expect(metrics.mounted).toBeLessThan(60);expect(metrics.columns).toBe(Math.max(1,Math.min(3,Math.floor((metrics.viewport-2*metrics.inset+metrics.gap)/(metrics.paper+metrics.gap)))));
 const scroller=lane.locator('[data-virtuoso-scroller]');await scroller.evaluate(node=>{node.scrollTop=node.scrollHeight;});
 await expect.poll(()=>completionRequests().length).toBeGreaterThan(1);expect(await lane.locator('[data-card-status=done]').count()).toBeLessThan(60);
 await capture(page,`web-completed-${width}`);
 await home.getByRole('button',{name:'보드 확대',exact:true}).click();const expanded=page.getByRole('dialog',{name:'전체 카드 보드'});
 await expanded.locator('.v3-card-board').evaluate(node=>{node.scrollLeft=node.scrollWidth;});
 await expect.poll(()=>expanded.locator('.v3-completed-grid').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(width===390?1:3);await expanded.getByLabel('제목 또는 요청 검색').fill('검색');await expect.poll(()=>completionRequests().some(url=>new URL(url).searchParams.get('q')==='검색')).toBe(true);
 await capture(page,`web-expanded-${width}`);
 await expanded.getByRole('button',{name:'지난 30일',exact:true}).click();await expect.poll(()=>completionRequests().some(url=>{const q=new URL(url).searchParams;return Date.parse(q.get('completedBefore')??'')-Date.parse(q.get('completedFrom')??'')===30*24*60*60*1000;})).toBe(true);
 await expanded.getByRole('button',{name:'전체',exact:true}).click();await expect.poll(()=>completionRequests().some(url=>!new URL(url).searchParams.has('completedFrom'))).toBe(true);
 await expanded.getByLabel('제목 또는 요청 검색').fill('결과가 없는 제목');await expect(expanded.getByText('선택한 기간에 완료 카드가 없습니다')).toBeVisible();await capture(page,`web-empty-${width}`);await expanded.getByLabel('제목 또는 요청 검색').fill('검색');await expect(expanded.locator('[data-card-status=done]').first()).toBeVisible();await expanded.getByRole('button',{name:'확대 닫기'}).click();
 await expect(home.getByLabel('제목 또는 요청 검색')).toHaveValue('검색');await expect(home.getByRole('switch',{name:'완료 숨김'})).not.toBeChecked();
 await home.getByRole('button',{name:'일반 보기'}).click();await expect(home.getByTestId('completed-viewport')).toBeVisible();await capture(page,`web-regular-${width}`);
 if(width===390){await page.getByTestId('v3-mobile-tab-projects').click();await page.getByTestId('v3-mobile-project-list').getByRole('button',{name:'소울스트림',exact:true}).click();}
 else await page.getByTestId('v3-all-projects').getByRole('button',{name:'소울스트림',exact:true}).click();
 const folder=page.getByTestId('folder-card-section');await folder.scrollIntoViewIfNeeded();await expect(folder.getByRole('switch',{name:'완료 숨김'})).toBeChecked();
 await folder.getByRole('switch',{name:'완료 숨김'}).click();await folder.locator('.v3-card-board').evaluate(node=>{node.scrollLeft=node.scrollWidth;});await expect(folder.locator('[data-card-status=done]').first()).toBeVisible();
 expect(state.requests.filter(url=>new URL(url).pathname.startsWith('/api/planner/folders/')&&!/\/(sessions|subfolders)$/.test(new URL(url).pathname)).every(url=>new URL(url).searchParams.get('includeCompleted')==='false')).toBe(true);
 await capture(page,`web-folder-${width}`);
 await page.goto('/components');const sample=page.getByTestId('card-board-sample');await sample.locator('.v3-card-board-workspace').scrollIntoViewIfNeeded();
 await sample.locator('.v3-card-board-workspace').getByRole('switch',{name:'완료 숨김'}).click();await sample.locator('.v3-card-board').evaluate(node=>{node.scrollLeft=node.scrollWidth;});
 await expect(sample.locator('[data-board-column=done] [data-card-status=done]').first()).toBeVisible();await capture(page,`web-gallery-${width}`);
 await sample.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();await expect(page.getByTestId('card-detail')).toBeVisible();await capture(page,`web-detail-tabs-${width}`);expect(state.errors).toEqual([]);writeFileSync(path.join(output,`web-metrics-${width}.json`),JSON.stringify({metrics,requests:state.requests,errors:state.errors},null,2));
});
for(const width of [390,1210])test(`RN web completed gallery ${width}`,async({page})=>{
 await page.setViewportSize({width,height:1000});await fixture(page);await page.goto(`/assets/ios-components/?section=boardConnected`);
 await expect(page.getByTestId('card-board-workspace')).toBeVisible();await capture(page,`rn-hidden-${width}`);
 if(baseline)return;
 await page.getByLabel('완료 숨김').click();await page.getByTestId('card-board').evaluate(node=>{node.scrollLeft=node.scrollWidth;});
 const done=page.getByTestId('card-board-scroll-done');await expect(done.locator('[data-testid^="postit-card-"]').first()).toBeVisible();
 const mounted=await done.locator('[data-testid^="postit-card-"]').count();expect(mounted).toBeLessThan(60);
 await capture(page,`rn-completed-${width}`);await page.getByTestId('completed-search').fill('검색');
 await expect.poll(()=>done.locator('[data-testid^="postit-card-"]').first().textContent()).toContain('검색');
 await capture(page,`rn-search-${width}`);
 await page.goto('/assets/ios-components/?section=folderWorkspace');const list=page.getByTestId('task-workspace-scroll');await expect(list).toBeVisible();
 await page.getByLabel('완료 숨김').scrollIntoViewIfNeeded();await capture(page,`rn-folder-hidden-${width}`);await page.getByLabel('완료 숨김').click();
 await expect(list.getByText('60개 표시',{exact:true})).toBeVisible();
 await list.locator('[data-testid^="postit-card-completed-"]').first().scrollIntoViewIfNeeded();await capture(page,`rn-folder-completed-${width}`);
 const folderMounted=await list.locator('[data-testid^="postit-card-completed-"]').count();expect(folderMounted).toBeLessThan(60);
 await list.evaluate(node=>{node.scrollTop=node.scrollHeight;});await expect(list.getByText('120개 표시',{exact:true})).toBeAttached();await page.waitForTimeout(300);
 const folderMountedAfterPage=await list.locator('[data-testid^="postit-card-completed-"]').count();expect(folderMountedAfterPage).toBeLessThan(120);
 await page.goto('/assets/ios-components/?section=entryShell');await expect(page.getByTestId('card-board-workspace')).toBeVisible();await capture(page,`rn-entry-header-${width}`);
 const actions=await Promise.all(['완료 숨김','드래프트 카드 추가','기존 데일리 기록'].map(async name=>page.getByLabel(name,{exact:true}).first().evaluate(node=>{const r=node.getBoundingClientRect();return {label:node.getAttribute('aria-label'),x:r.x,y:r.y,width:r.width,height:r.height};})));
 writeFileSync(path.join(output,`rn-metrics-${width}.json`),JSON.stringify({mounted,folderMounted,folderMountedAfterPage,actions,platform:'RN web; native unmeasured'}));
});

if(process.env.COMPLETED_METRICS==='1')test('web header layout coordinates',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await fixture(page);await page.goto('/');
 const head=page.getByTestId('card-home').locator('.v3-card-board-workspace > .v3-detail-section-head');await expect(head).toBeVisible();
 const measurements=await head.evaluate(node=>{const rect=(el:Element)=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,centerY:r.y+r.height/2,right:r.right};};return {head:rect(node),title:rect(node.querySelector('h3')!),toggle:rect(node.querySelector('.v3-card-completion-filter')!),actions:rect(node.querySelector('.v3-card-actions')!),gap:getComputedStyle(node).gap};});
 expect(Math.abs(measurements.title.centerY-measurements.toggle.centerY)).toBeLessThanOrEqual(1);expect(Math.abs(measurements.toggle.centerY-measurements.actions.centerY)).toBeLessThanOrEqual(1);expect(Math.abs(measurements.actions.right-measurements.head.right)).toBeLessThanOrEqual(1);
 writeFileSync(path.join(output,'web-header-coordinates.json'),JSON.stringify(measurements,null,2));
});

if(process.env.COMPLETED_REBASE==='1')test('rebased gallery preserves completed grid and shared detail sample',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await fixture(page);await page.goto('/components');
 const sample=page.getByTestId('card-board-sample');await sample.locator('.v3-card-board-workspace').scrollIntoViewIfNeeded();
 await sample.locator('.v3-card-board-workspace').getByRole('switch',{name:'완료 숨김'}).click();await sample.locator('.v3-card-board').evaluate(node=>{node.scrollLeft=node.scrollWidth;});
 await expect(sample.locator('[data-board-column=done] [data-card-status=done]').first()).toBeVisible();
 await sample.getByTestId('postit-size-comparison').locator('.v3-postit-open').first().click();const detail=page.getByTestId('card-detail');await expect(detail).toBeVisible();
 await detail.getByRole('tab',{name:'내용',exact:true}).click();await expect(detail.getByText('내부 요약을 접지 않고 표시합니다.',{exact:true})).toBeVisible();await expect(detail.getByText('커멘트',{exact:true}).first()).toBeVisible();await capture(page,'web-detail-rebased-1440');
});
