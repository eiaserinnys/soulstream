import { test,expect } from '@playwright/test';
import { mkdirSync,writeFileSync } from 'node:fs';
import path from 'node:path';
const output=path.resolve('../../../.local/artifacts/20261002-jev-card-turn-observation');
for(const width of [390,1210,1440]) {
  test(`same caption comparison web/native preview ${width}`,async({page})=>{
    mkdirSync(output,{recursive:true});
    const errors:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setViewportSize({width,height:1000});
    await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
    await page.addInitScript(()=>{localStorage.setItem('soul-dashboard-theme','dark');localStorage.setItem('ls.webglGlass','0');});
    await page.route('**/api/auth/config',r=>r.fulfill({json:{authEnabled:false,devModeEnabled:true}}));
    await page.route('**/api/auth/status',r=>r.fulfill({json:{authenticated:true,user:{email:'qa@example.test',name:'QA'}}}));
    await page.goto('/components');
    const comparison=page.getByTestId('jev-caption-comparison');
    await expect(comparison).toBeVisible();
    await comparison.scrollIntoViewIfNeeded();
    await expect(comparison.getByText('Jev · 완료 가능 · 관측 범위 제한',{exact:true})).toBeVisible();
    await expect(comparison.getByRole('button')).toHaveCount(0);
    const metrics=await comparison.locator('[data-tree-node-id]').evaluateAll(nodes=>nodes.map(n=>{
      const el=n.children[1]!,r=el.getBoundingClientRect(),s=getComputedStyle(el);
      return {id:n.getAttribute('data-tree-node-id'),x:r.x,right:r.right,font:s.fontSize,padding:s.padding,background:s.backgroundColor};
    }));
    expect(metrics[1]!.x).toBe(metrics[2]!.x);
    expect(metrics[1]!.font).toBe(metrics[2]!.font);
    expect(metrics[1]!.padding).toBe(metrics[2]!.padding);
    await page.screenshot({path:path.join(output,`web-caption-${width}.png`),animations:'disabled'});
    await page.goto('http://127.0.0.1:4199/assets/ios-components/?section=chat');
    const native=page.getByText('기존 caption · 기존 요약과 요청한 Jev 판정 한 줄',{exact:true});
    await native.scrollIntoViewIfNeeded();
    await expect(page.getByText('Jev · 완료 가능 · 관측 범위 제한',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Jev 분류 정보'})).toHaveCount(0);
    await page.screenshot({path:path.join(output,`native-web-preview-caption-${width}.png`),animations:'disabled'});
    expect(errors).toEqual([]);
    writeFileSync(path.join(output,`caption-metrics-${width}.json`),JSON.stringify({width,web:metrics,native:'실제 RN 컴포넌트의 웹 검수 preview입니다. iOS 실기기 증거가 아닙니다.',errors},null,2));
  });
}
