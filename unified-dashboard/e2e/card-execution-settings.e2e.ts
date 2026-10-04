import {expect,test} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {installV3VisualQaRoutes} from './v3-visual-fixtures';
const output=process.env.CARD_EXECUTION_CAPTURE_DIR!;
test.use({serviceWorkers:'block'});
for(const width of [1440,390])test(`card assignment panel and editor at ${width}`,async({page})=>{
 mkdirSync(output,{recursive:true});
 await page.setViewportSize({width,height:1000});
 await page.addInitScript(()=>{localStorage.setItem('ls.webglGlass','0');localStorage.setItem('soul-dashboard-theme','light');});
 await installV3VisualQaRoutes(page);
 await page.route('**/api/auth/config',route=>route.fulfill({json:{authEnabled:false,devModeEnabled:true}}));
 await page.route('**/api/auth/status',route=>route.fulfill({json:{authenticated:true,user:{email:'qa@example.test',name:'QA'}}}));
 const operationalWrites:string[]=[];
 page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/api/cards'))operationalWrites.push(request.url());});
 await page.goto('/components#components-board');
 const sample=page.getByTestId('card-board-sample');
 await expect(sample).toBeVisible();
 const metrics:Record<string,unknown>={};
 for(const scenario of ['담당 연결','에이전트 지정','부분 설정','담당 없음','실행 중']){
  await sample.getByRole('button',{name:scenario,exact:true}).click();
  await sample.getByTestId('postit-size-comparison').locator('article .v3-postit-open').first().click();
  if(width===390)await page.getByTestId('v3-mobile-tab-today').click();
  const panel=page.getByTestId('card-detail');await expect(panel).toBeVisible();await page.waitForTimeout(250);
  const assigned=['담당 연결','실행 중'].includes(scenario);
  if(assigned)await expect(panel.getByRole('button',{name:'카드 실행 설정 편집',exact:true})).toHaveCount(0);else await expect(panel.getByRole('button',{name:'카드 실행 설정 편집',exact:true})).toBeVisible();
  await expect(panel.getByRole('button',{name:'완료',exact:true})).toBeVisible();
  await expect(panel.locator('textarea')).toBeVisible();
  await expect(panel.locator('[data-card-section="sessions"]')).toBeVisible();
  metrics[scenario]=await panel.evaluate(element=>{
    const box=(node:Element|null)=>{if(!node)return null;const r=node.getBoundingClientRect();const s=getComputedStyle(node);return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,font:s.fontSize,padding:s.padding};};
    return {panel:box(element),header:box(element.querySelector('.v3-folder-header')),composer:box(element.querySelector('.v3-card-composer-slot')),settings:box(element.querySelector('.v3-task-default-assignment')),documentWidth:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  if(['담당 연결','에이전트 지정'].includes(scenario))await page.screenshot({path:`${output}/web-${width}-${assigned?'assigned':'before'}.png`,animations:'disabled'});
  if(scenario==='에이전트 지정'){
   await panel.getByRole('button',{name:'카드 실행 설정 편집',exact:true}).click();
   const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('폴더 선택',{exact:true})).toBeVisible();
   await dialog.locator('details').evaluate((element:HTMLDetailsElement)=>{element.open=true;});
   for(const name of ['노드 선택','에이전트 선택','모델 선택'])await expect(dialog.getByLabel(name,{exact:true})).toBeVisible();
   await page.screenshot({path:`${output}/web-${width}-editor.png`,animations:'disabled'});
   await dialog.getByRole('button',{name:'취소',exact:true}).click();
  }
  await page.getByRole('button',{name:'카드 닫기',exact:true}).click();
 }
 expect(operationalWrites).toEqual([]);
 writeFileSync(`${output}/web-${width}-layout.json`,JSON.stringify(metrics,null,2));
 await page.goto('/assets/ios-components/?section=cardHome');
 const home=page.getByTestId('review-card-home');await expect(home).toBeVisible();
 for(const scenario of ['assigned','agent','partial','unassigned','live']){
  await page.getByTestId(`settings-segment-card-assignment-scenario-${scenario}`).click();
  await home.getByLabel(/카드 상세/).first().click();
  const panel=page.getByTestId('card-detail-container');await expect(panel).toBeVisible();
  const assigned=['assigned','live'].includes(scenario);
  if(assigned)await expect(panel.getByLabel('폴더 변경',{exact:true})).toHaveCount(0);else await expect(panel.getByLabel('폴더 변경',{exact:true})).toBeVisible();
  await expect(panel.getByLabel('완료',{exact:true})).toBeVisible();
  await expect(panel.getByTestId('card-comment-composer')).toBeVisible();
  await expect(panel.getByTestId('card-sessions')).toBeAttached();
  if(['assigned','agent'].includes(scenario))await page.screenshot({path:`${output}/app-rn-web-${width}-${assigned?'assigned':'before'}.png`,animations:'disabled'});
  if(scenario==='agent'){
   await panel.getByLabel('폴더 변경',{exact:true}).click();
   await expect(page.getByText('맡길 대상',{exact:true})).toBeVisible();
   await page.screenshot({path:`${output}/app-rn-web-${width}-editor.png`,animations:'disabled'});
   await page.getByText('취소',{exact:true}).click();
  }
  await panel.getByLabel('뒤로',{exact:true}).click();
 }
 expect(operationalWrites).toEqual([]);
});
