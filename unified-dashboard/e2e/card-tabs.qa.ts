import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {installV3VisualQaRoutes} from './v3-visual-fixtures';
const phase=process.env.CARD_TABS_PHASE??'after';
const output=path.resolve('../../../.local/artifacts/20261002-card-common-regions');
const now='2026-10-01T00:00:00Z';
for(const width of [1440,390])test(`card tabs ${width} ${phase}`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
 await page.clock.install({time:new Date(now)});
 await page.addInitScript(()=>{
  localStorage.setItem('soul-dashboard-theme','dark');localStorage.setItem('ls.webglGlass','0');localStorage.setItem('soul-user-preferences:qa@example.test',JSON.stringify({chatFontSize:17}));
  localStorage.setItem('cards-p1-handoff',JSON.stringify({folderId:'folder-amber',nodeId:'eiaserinnys',agentId:'roselin_codex',modelPreset:'qa-standard'}));
  Object.defineProperty(navigator.serviceWorker,'register',{configurable:true,value:async()=>({update:async()=>undefined,active:null,addEventListener:()=>undefined})});
  Object.defineProperty(navigator.serviceWorker,'controller',{configurable:true,get:()=>null});
 });
 await installV3VisualQaRoutes(page,{unifiedFolderView:true,timelineEventCount:1,liveEventText:'채팅 말풍선의 기준 본문입니다.'});
 const card={id:'inherit',folderId:'other',title:'기존 요소를 상속하는 긴 카드 제목을 말줄임으로 확인합니다',request:'지시 첫 줄\n둘째 줄\n셋째 줄\n넷째 줄',brief:'펼친 내부 정보\n\n'.repeat(60),status:'running',blockedKind:null,positionKey:'a',queuePositionKey:null,assigneeKind:'session',assigneeSessionId:'run-alpha-1',nodeId:'eiaserinnys',assigneeAgentId:'roselin_codex',modelPreset:'qa-standard',version:1,archived:false,createdAt:now,updatedAt:now};
 const sessions=Array.from({length:4},(_,i)=>({sessionId:`run-alpha-${i+1}`,agentSessionId:`run-alpha-${i+1}`,callerSessionId:i?'run-alpha-1':null,folderId:'folder-amber',displayName:`세션 ${i+1}`,status:'completed',agentName:'로젤린',agentId:'roselin_codex',nodeId:'eiaserinnys',modelLabel:'Sol',eventCount:1,prompt:'세션의 기존 미리보기',createdAt:now,updatedAt:now}));
 const reports=[{id:'report',title:'최신 보고 제목',body:'보고 첫 줄\n둘째 줄\n셋째 줄\n넷째 줄\n\n![보고 캡처](https://example.test/capture.svg)',format:'markdown',createdAt:now,sessionId:'run-alpha-1'}];
 const questions=[{id:'question',text:'확인이 필요한 질문입니다.',options:['확인'],answer:'확인한 답변입니다.',askedAt:now,answeredAt:now}];
 const comments:any[]=[{id:'first-comment',cardId:card.id,authorKind:'user',kind:'comment',body:'추가 커멘트를 읽고 아래에서 입력합니다.',createdAt:now}],writes:any[]=[];let showFolderCards=false;
 const folderCards=Array.from({length:6},(_,i)=>({...card,id:i?`folder-card-${i}`:card.id,folderId:"folder-amber",positionKey:String(i)}));
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname;
  const json=(v:unknown)=>route.fulfill({contentType:'application/json',body:JSON.stringify(v)});
  if(p==='/api/user/preferences')return json({preferences:{chatFontSize:17},hasBackground:false});
  if(p==='/api/auth/config')return json({authEnabled:true,devModeEnabled:false});
  if(p==='/api/auth/status')return json({authenticated:true,user:{email:'qa@example.test',name:'QA',isAdmin:true}});
  if(p==='/api/planner/today')return json({daily:{page:{id:'daily',title:'오늘',version:1,metadata:{},archived:false},blocks:[],state_vector:''},folders:[],memoBlocks:[],reviewSessionIds:[],attention:[],running:[card],queued:[]});
  if(p==='/api/cards')return json({cards:url.searchParams.has('folderId')?(showFolderCards?folderCards:[]):[card]});
  if(p.startsWith('/api/cards/folder-card-'))return json({card:folderCards.find(card=>card.id===p.split('/').at(-1)),sessions,reports,comments,questions});
  if(p==='/api/cards/inherit')return json({card:showFolderCards?folderCards[0]:card,sessions,reports,comments,questions});
  if(p==='/api/cards/inherit/comments'){const payload=req.postDataJSON();writes.push(payload);const comment={id:'comment',cardId:card.id,authorKind:'user',body:payload.body,kind:'comment',createdAt:now};comments.push(comment);return json(comment);}
  if(p==='/api/attachments/sessions'){expect(req.postData()).toContain('run-alpha-1');return json({path:'/uploads/run-alpha-1/evidence.png'});}
  if(p==='/api/attachments/files')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#4373aa"/></svg>'});
  if(p==='/api/sessions'&&url.searchParams.has('session_id'))return json({sessions:sessions.filter(s=>url.searchParams.getAll('session_id').includes(s.agentSessionId)),total:sessions.length});
  if(p==='/api/planner/folders/folder-amber/sessions')return json({items:sessions,nextCursor:null});
  if(p==='/api/planner/folders/folder-amber')return json({cards:[],folder:{id:'folder-amber',name:'소울스트림',projectPageId:'project-amber',parentFolderId:null,sortOrder:0,settings:{},status:'open',version:1,archived:false},page:{id:'project-amber',title:'소울스트림',version:1,metadata:{},archived:false},blocks:[],subfolders:{items:[],nextCursor:null},sessions:{items:sessions,nextCursor:null}});
  return route.fallback();
 });
 await page.route('https://example.test/capture.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect width="200" height="120" fill="#4373aa"/></svg>'}));
 mkdirSync(output,{recursive:true});

 await page.goto('/v3');
 const cardRow=page.locator('article[data-card-id=inherit]');
 await expect(cardRow).toBeVisible();
 await cardRow.getByRole('button',{name:`카드 ${card.title} 열기`,exact:true}).click();
 const detail=page.getByTestId('card-detail');await expect(detail).toBeVisible();await expect(detail.locator('[data-card-entry=커멘트]')).toHaveCount(1);
 await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:path.join(output,`${phase}-${width}-card.png`),animations:'disabled'});
 if(phase==='before')return;
 const input=detail.getByPlaceholder('커멘트',{exact:true});
 const sessionsRegion=detail.locator('[data-card-section=sessions]');
 const body=detail.getByRole('tabpanel');
 const fixed=async()=>{
  await detail.evaluate(pane=>Promise.all(pane.parentElement!.getAnimations().map(animation=>animation.finished)));
  return detail.evaluate(pane=>{
  const box=(selector:string)=>{const r=pane.querySelector(selector)!.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};};
  return {sessions:box('[data-card-section=sessions]'),tabs:box('[role=tablist]'),dock:box('.v3-card-comment-dock'),composer:box('[data-slot=chat-input-composer]'),body:box('[role=tabpanel]')};
 });
 };
 const sameFixed=(a:Awaited<ReturnType<typeof fixed>>,b:Awaited<ReturnType<typeof fixed>>)=>{
  for(const region of ['sessions','dock'] as const)for(const axis of ['left','right','top','bottom'] as const)expect(Math.abs(a[region][axis]-b[region][axis])).toBeLessThanOrEqual(1);
 };
 for(const label of ['지시','보고','질문','답','커멘트'])await expect(detail.locator(`[data-card-entry="${label}"]`)).toHaveCount(1);
 await expect(sessionsRegion).toBeVisible();await expect(input).toBeVisible();
 const start=await fixed();
 expect(Math.abs(start.tabs.left-start.composer.left)).toBeLessThanOrEqual(1);
 expect(Math.abs(start.tabs.right-start.composer.right)).toBeLessThanOrEqual(1);
 await input.fill('입력 중 문장');
 await detail.locator('input[type=file]').setInputFiles({name:'evidence.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf9sAAAAASUVORK5CYII=','base64')});
 await expect(detail.locator('[title="evidence.png"]')).toBeVisible();
 // Keep the same input/file across both tabs; compare with the attachment in both states.
 const withAttachment=await fixed();
 await body.evaluate(el=>{el.scrollTop=0;});
 await page.screenshot({path:path.join(output,`after-${width}-comments.png`),animations:'disabled'});
 await detail.getByRole('tab',{name:'노트',exact:true}).click();
 await expect(sessionsRegion).toBeVisible();await expect(input).toBeVisible();
 await expect(input).toHaveValue('입력 중 문장');await expect(detail.locator('[title="evidence.png"]')).toBeVisible();
 await expect(body.locator('[data-card-entry],details,summary')).toHaveCount(0);
 await expect(body).toContainText('펼친 내부 정보');
 const contentBefore=await fixed();sameFixed(withAttachment,contentBefore);
 await body.evaluate(el=>{el.scrollTop=0;});
 await page.screenshot({path:path.join(output,`after-${width}-content.png`),animations:'disabled'});
 await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});
 expect(await body.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 const contentAfter=await fixed();sameFixed(contentBefore,contentAfter);
 // Send text plus attachment from the notes tab.
 await detail.getByTestId('send-button').click();await expect(input).toHaveValue('');
 expect(writes[0].body).toContain('입력 중 문장');expect(writes[0].body).toContain('![evidence.png]');
 await detail.getByRole('tab',{name:'커멘트',exact:true}).click();
 await expect(detail.locator('[data-card-entry=커멘트]')).toHaveCount(2);
 await input.fill('커멘트 탭 전송');await detail.getByTestId('send-button').click();await expect(input).toHaveValue('');
 expect(writes[1].body).toBe('커멘트 탭 전송');
 await input.fill('여러 줄 입력\n'.repeat(10));
 await page.screenshot({path:path.join(output,`after-${width}-expanded-input.png`),animations:'disabled'});
 await input.fill('');
 if(width>=760){
  await detail.locator('.v3-run-open').first().click();
  await expect(page.getByTestId('v3-card-session-chat').locator('[data-slot=chat-input-composer]')).toBeVisible();
  await page.screenshot({path:path.join(output,`after-${width}-session.png`),animations:'disabled'});
  sameFixed(start,await fixed());
 }
 comments.push(...Array.from({length:20},(_,index)=>({id:`long-${index}`,cardId:card.id,authorKind:'user',kind:'comment',body:`커멘트 ${index+1}: 긴 대화에서도 입력창이 아래에 남습니다.`,createdAt:now})));
 await page.reload();await cardRow.getByRole('button',{name:`카드 ${card.title} 열기`,exact:true}).click();
 await expect(detail.locator('[data-card-entry=커멘트]')).toHaveCount(23);
 await body.evaluate(el=>{el.scrollTop=0;});const longBefore=await fixed();
 await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});expect(await body.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 const longAfter=await fixed();sameFixed(longBefore,longAfter);sameFixed(start,longAfter);
 await page.screenshot({path:path.join(output,`after-${width}-long.png`),animations:'disabled'});
 // Session expansion remains mounted across the tabs.
 await sessionsRegion.getByRole('button',{name:'1개 더',exact:true}).click();
 await expect(sessionsRegion.locator('.v3-run-open')).toHaveCount(4);
 await detail.getByRole('tab',{name:'노트',exact:true}).click();await expect(sessionsRegion.locator('.v3-run-open')).toHaveCount(4);
 writeFileSync(path.join(output,`after-${width}-metrics.json`),JSON.stringify({start,withAttachment,contentBefore,contentAfter,longBefore,longAfter},null,2));
 // Registered samples render the same CardWorkspace / CardDetailPane composition.
 await page.goto('/components');
 const board=page.getByTestId('card-board-sample');
 await board.getByRole('button',{name:'긴 커멘트',exact:true}).click();
 await board.locator('[data-card-id] button').first().click();await expect(detail).toBeVisible();
 await expect(detail.locator('[data-card-entry=커멘트]')).toHaveCount(20);
 for(const label of ['지시','보고','질문','답'])await expect(detail.locator(`[data-card-entry="${label}"]`)).toHaveCount(1);
 await expect(sessionsRegion).toBeVisible();await expect(input).toBeVisible();
 await body.evaluate(el=>{el.scrollTop=0;});const sampleComments=await fixed();
 await page.screenshot({path:path.join(output,`after-${width}-sample-comments.png`),animations:'disabled'});
 await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});sameFixed(sampleComments,await fixed());
 await detail.getByRole('tab',{name:'노트',exact:true}).click();await expect(input).toBeVisible();await expect(sessionsRegion).toBeVisible();
 await expect(body).toContainText('내부 요약을 접지 않고 표시합니다.');await expect(body.locator('details,summary')).toHaveCount(0);
 await body.evaluate(el=>{el.scrollTop=0;});sameFixed(sampleComments,await fixed());
 await page.screenshot({path:path.join(output,`after-${width}-sample-content.png`),animations:'disabled'});
 await body.evaluate(el=>{el.scrollTop=el.scrollHeight;});expect(await body.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);sameFixed(sampleComments,await fixed());
});
