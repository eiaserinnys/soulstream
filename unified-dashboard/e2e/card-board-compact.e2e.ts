import {test,expect} from "@playwright/test";
import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {installV3VisualQaRoutes} from "./v3-visual-fixtures";
import {DEFAULT_USER_PREFERENCES} from "../../packages/soul-ui/src/lib/user-preferences";

const output=path.resolve("../../../.local/artifacts/20261005-card-content-status-menu-compact");
for(const [width,fontSize] of [[1440,17],[1210,17],[390,17],[1210,14],[1210,18]])test(`compact comparison ${width} font ${fontSize}`,async({page})=>{
  mkdirSync(output,{recursive:true});const writes:string[]=[];
  await page.setViewportSize({width,height:width===1210?834:1000});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.addInitScript(()=>{localStorage.setItem("ls.webglGlass","0");Object.defineProperty(navigator.serviceWorker,"register",{configurable:true,value:async()=>({update:async()=>{},active:null,addEventListener:()=>{}})});});
  await installV3VisualQaRoutes(page);
  await page.route("**/api/auth/config",route=>route.fulfill({json:{authEnabled:true,devModeEnabled:false}}));
  await page.route("**/api/auth/status",route=>route.fulfill({json:{authenticated:true,user:{email:"compact@example.test",name:"검수"}}}));
  await page.route("**/api/user/preferences",route=>route.fulfill({json:{email:"compact@example.test",preferences:{...DEFAULT_USER_PREFERENCES,chatFontSize:fontSize},hasBackground:false}}));
  page.on("request",request=>{if(new URL(request.url()).pathname.startsWith("/api/cards")&&request.method()!=="GET")writes.push(request.url());});
  await page.goto("/components");const sample=page.getByTestId("card-board-sample"),comparison=page.getByTestId("postit-size-comparison");
  await expect(comparison.locator(".v3-postit-card")).toHaveCount(2);
  await expect(comparison.locator(".v3-postit-body").first()).toHaveCSS("font-size",`${fontSize}px`);
  await page.evaluate(()=>document.fonts.ready);
  const sizes=await comparison.locator(".v3-postit-card").evaluateAll(nodes=>nodes.map(node=>{
    const card=node as HTMLElement,body=card.querySelector<HTMLElement>(".v3-postit-body")!,footer=card.querySelector<HTMLElement>(".v3-postit-footer")!,title=card.querySelector<HTMLElement>(".v3-postit-title")!;
    const style=getComputedStyle(card),b=getComputedStyle(body),t=getComputedStyle(title),trigger=card.querySelector<HTMLElement>(".v3-postit-status-trigger")!;
    return {variant:card.dataset.cardSize,width:parseFloat(style.width),height:parseFloat(style.height),bodyFont:parseFloat(b.fontSize),line:parseFloat(b.lineHeight),lines:b.webkitLineClamp,
      labelPresent:Boolean(card.querySelector(".v3-postit-latest-label")),titleFont:parseFloat(t.fontSize),titleLine:parseFloat(t.lineHeight),text:body.textContent,
      bodyBottom:body.offsetTop+body.offsetHeight,footerTop:footer.offsetTop,rotation:style.transform,actionCount:card.querySelectorAll(".dashboard-icon-cap").length,trigger:[trigger.offsetWidth,trigger.offsetHeight]};
  }));
  for(const item of sizes){const factor=item.variant==="compact"?0.8:1;
    expect(item.width).toBeCloseTo(320*fontSize/17*factor,1);expect(item.height).toBeCloseTo(280*fontSize/17*factor,1);
    expect(item.bodyFont).toBe(fontSize);expect(item.line).toBeCloseTo(25*fontSize/17,2);
    expect(item.labelPresent).toBe(false);expect(item.actionCount).toBe(0);expect(item.lines).toBe(item.variant==="compact"?"3":"5");
    expect(item.bodyBottom).toBeLessThanOrEqual(item.footerTop);expect(Math.min(...item.trigger)).toBeGreaterThanOrEqual(32);
  }
  expect(sizes[0].text).toBe(sizes[1].text);expect(sizes[0].rotation).toBe(sizes[1].rotation);
  expect(sizes[0].titleFont).toBe(sizes[1].titleFont);expect(sizes[0].titleLine).toBe(sizes[1].titleLine);
  expect(sizes.map(item=>item.lines)).toEqual(["4","2"]);
  const capture=async(name:string)=>page.screenshot({path:path.join(output,`compact-${name}-${width}-font${fontSize}.png`),animations:"disabled"});
  await comparison.scrollIntoViewIfNeeded();await comparison.screenshot({path:path.join(output,`compact-comparison-${width}-font${fontSize}.png`),animations:"disabled"});
  const board=sample.locator(".v3-card-board");await expect(board.locator("[data-board-column]")).toHaveCount(6);
  await board.scrollIntoViewIfNeeded();
  const lanes=await board.evaluate(element=>{const rect=element.getBoundingClientRect(),columns=[...element.querySelectorAll("[data-board-column]")].map(e=>e.getBoundingClientRect());
    return {availableWidth:element.clientWidth,scrollWidth:element.scrollWidth,columnWidths:columns.map(r=>r.width),headerY:[...element.querySelectorAll(".v3-detail-section-head")].map(e=>e.getBoundingClientRect().y),
      fullyVisible:columns.filter(r=>r.left>=rect.left&&r.right<=rect.right).length,cardWidth:parseFloat(getComputedStyle(element.querySelector(".v3-postit-card")!).width)};});
  expect(lanes.cardWidth).toBe(sizes[1].width);expect(new Set(lanes.columnWidths).size).toBe(1);expect(new Set(lanes.headerY).size).toBe(1);
  expect(lanes.scrollWidth).toBeGreaterThan(lanes.availableWidth);await capture("board");
  await board.evaluate(element=>element.scrollLeft=element.scrollWidth);await expect(board).toContainText("완료 1개 숨김");await capture("hidden");
  await sample.getByRole("button",{name:"완료 포함 켜기",exact:true}).click();await expect(board.locator('[data-card-status="done"]')).toHaveCount(1);
  await capture("done-on");
  // Both comparison cards share fixture state and the existing guarded picker.
  await comparison.locator('[data-card-size="compact"]').getByRole("button",{name:"카드 상태 변경"}).click();
  let picker=page.locator("[data-card-status-picker]");await picker.getByRole("button",{name:"실행 중",exact:true}).click();
  await expect(comparison.locator('[data-card-status="running"]')).toHaveCount(2);expect(writes).toEqual([]);
  await comparison.locator('[data-card-size="compact"]').getByRole("button",{name:"카드 상태 변경"}).click();
  picker=page.locator("[data-card-status-picker]");await picker.getByRole("button",{name:"완료",exact:true}).click();
  await expect(comparison.locator('[data-card-status="done"]')).toHaveCount(2);expect(writes).toEqual([]);

  await sample.getByRole("button",{name:"보드 확대",exact:true}).click();
  const expanded=page.locator('[data-card-board-expanded="true"]');await expect(expanded).toBeVisible();
  const target=expanded.locator('[data-board-column="todo"] .v3-postit-card').first();
  const trigger=target.getByRole("button",{name:"카드 상태 변경"});await trigger.focus();await page.keyboard.press("Shift+F10");
  const context=page.locator('[data-slot="menu-popup"]');await expect(context).toBeVisible();await capture("expanded-context-menu");
  await page.keyboard.press("Escape");await expect(context).toBeHidden();await expect(expanded).toBeVisible();await expect(trigger).toBeFocused();
  await expanded.getByRole("button",{name:"확대 닫기",exact:true}).click();
  writeFileSync(path.join(output,`compact-metrics-${width}-font${fontSize}.json`),JSON.stringify({viewport:{width,height:width===1210?834:1000},sizes,lanes,writes},null,2));
});
