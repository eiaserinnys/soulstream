import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const phase = process.env.IMAGE_VIEWER_PHASE ?? "after";
const output = path.resolve("../../../.local/artifacts/20261012-image-viewer", phase);
mkdirSync(output, {recursive:true});
const cases = [[1920,1080,800,600],[1920,1080,2560,1440],[1920,1080,1200,2800],[1920,1080,64,64],[390,844,800,600]];
async function open(page: Page, viewer: string, vw:number, vh:number, w:number, h:number, caption="") {
  await page.setViewportSize({width:vw,height:vh});
  await page.emulateMedia({colorScheme:"light",reducedMotion:"reduce"});
  await page.addInitScript(()=>localStorage.setItem("ls.webglGlass","0"));
  await page.route(/\/(fixture|next)\.svg/,route=>{
    const url=new URL(route.request().url());
    const width=url.pathname==="/next.svg"?64:Number(url.searchParams.get("width"));
    const height=url.pathname==="/next.svg"?64:Number(url.searchParams.get("height"));
    return route.fulfill({contentType:"image/svg+xml",body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="steelblue"/><text x="12" y="40" fill="white" font-size="24">${width} × ${height}</text></svg>`});
  });
  await page.goto(`/e2e/image-viewer.fixture.html?viewer=${viewer}&width=${w}&height=${h}&caption=${caption}`);
  if(viewer==="chat") await page.locator("img[role=button]").first().click();
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
  return popup;
}
async function metrics(popup: Locator) {
  return popup.evaluate(el=>{
    const rect=(node:Element)=>node.getBoundingClientRect().toJSON();
    const image=el.querySelector("img")!;
    const style=getComputedStyle(el);
    const reserve=document.createElement("span");
    reserve.style.height="var(--image-viewer-block-reserve)";
    reserve.style.position="absolute";
    image.parentElement!.append(reserve);
    const reserved=reserve.getBoundingClientRect().height;
    reserve.remove();
    return {
      popup:rect(el),image:rect(image),natural:[image.naturalWidth,image.naturalHeight],
      reserved,nonImage:el.clientHeight-image.getBoundingClientRect().height,
      inlineInset:el.clientWidth-image.getBoundingClientRect().width,
      edges:[...el.querySelectorAll("figcaption,[data-slot=dialog-header],[data-slot=dialog-footer]")].map(node=>({rect:rect(node),scroll:node.scrollHeight,client:node.clientHeight})),
      border:parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth),
      close:rect(el.querySelector('[aria-label="Close"]')!),
    };
  });
}
for(const viewer of ["card","file","chat"]) for(const [vw,vh,w,h] of cases) {
  test(`${viewer} ${vw}x${vh} ${w}x${h}`, async({page})=>{
    const popup=await open(page,viewer,vw,vh,w,h);
    const data=await metrics(popup);
    const name=`${viewer}-${vw}x${vh}-${w}x${h}`;
    writeFileSync(path.join(output,name+".json"),JSON.stringify(data,null,2));
    await page.screenshot({path:path.join(output,name+".png"),animations:"disabled"});
    expect(data.natural).toEqual([w,h]);
    expect.soft(data.popup.x).toBeGreaterThanOrEqual(15);
    expect.soft(data.popup.y).toBeGreaterThanOrEqual(15);
    expect.soft(data.popup.right).toBeLessThanOrEqual(vw-15);
    expect.soft(data.popup.bottom).toBeLessThanOrEqual(vh-15);
    expect.soft(data.image.width).toBeLessThanOrEqual(w+1);
    expect.soft(data.image.height).toBeLessThanOrEqual(h+1);
    expect.soft(Math.abs(data.image.width/data.image.height-w/h)/(w/h)).toBeLessThan(.01);
    if(w===800 && vw===1920 || w===64) {
      expect.soft(data.image.width).toBeCloseTo(w,0);
      expect.soft(data.image.height).toBeCloseTo(h,0);
    } else {
      expect.soft(data.image.width<w || data.image.height<h).toBe(true);
    }
    const padding=viewer==="chat"?48:0;
    const expectedScale=Math.min(1,(vw-32-data.border-padding)/w,(vh-32-data.border-data.reserved)/h);
    expect.soft(Math.abs(data.image.width-w*expectedScale)).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(data.image.height-h*expectedScale)).toBeLessThanOrEqual(1);
    expect.soft(data.nonImage).toBeLessThanOrEqual(data.reserved+1);
    for(const edge of data.edges) {
      expect.soft(edge.rect.bottom).toBeLessThanOrEqual(data.popup.bottom+1);
      expect.soft(edge.scroll).toBeLessThanOrEqual(edge.client+1);
    }
    if(w===64) {
      expect.soft(data.popup.width).toBeCloseTo(320,0);
      expect.soft((data.image.left+data.image.right)/2).toBeCloseTo((data.popup.left+data.popup.right)/2,0);
      expect.soft(data.image.right).toBeLessThan(data.close.left);
    } else {
      expect.soft(data.popup.width).toBeCloseTo(Math.max(320,data.image.width+padding+data.border),0);
    }
    if(viewer==="chat") {
      await expect(popup.locator(".chat-image-viewer-title")).toBeVisible();
      await page.getByRole("button",{name:"다음 이미지"}).click();
      await expect(popup.locator("img")).toHaveAttribute("alt","next.svg");
      await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
      await expect.poll(async()=> (await metrics(popup)).popup.width).toBe(320);
    }
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
  });
}
test("long caption stays inside the card image popup",async({page})=>{
  const popup=await open(page,"card",390,844,1200,2800,"long");
  const data=await metrics(popup);
  writeFileSync(path.join(output,"card-long-caption.json"),JSON.stringify(data,null,2));
  await page.screenshot({path:path.join(output,"card-long-caption.png"),animations:"disabled"});
  expect(data.popup.bottom).toBeLessThanOrEqual(828);
  expect(data.edges[0].rect.bottom).toBeLessThanOrEqual(data.popup.bottom);
  expect(data.edges[0].scroll).toBe(data.edges[0].client);
});
test("ordinary popup preserves its original frame",async({page})=>{
  await page.setViewportSize({width:1920,height:1080});
  await page.addInitScript(()=>localStorage.setItem("ls.webglGlass","0"));
  await page.goto("/e2e/image-viewer.fixture.html?viewer=ordinary");
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await page.screenshot({path:path.join(output,"ordinary.png"),animations:"disabled"});
  expect((await popup.boundingBox())!.width).toBe(512);
});

test("supplement: three-line caption and outside dismissal",async({page})=>{
  const popup=await open(page,"card",1920,1080,1200,2800,"three");
  const data=await metrics(popup);
  const lines=await popup.locator("figcaption").evaluate(el=>{
    const style=getComputedStyle(el);
    return (el.clientHeight-parseFloat(style.paddingBottom))/parseFloat(style.lineHeight);
  });
  expect(lines).toBeGreaterThanOrEqual(2);
  expect(lines).toBeLessThanOrEqual(3);
  expect(data.nonImage).toBeLessThanOrEqual(data.reserved+1);
  expect(data.edges[0].rect.bottom).toBeLessThan(data.popup.bottom);
  writeFileSync(path.join(output,"card-three-lines.json"),JSON.stringify({...data,lines},null,2));
  await page.screenshot({path:path.join(output,"card-three-lines.png"),animations:"disabled"});
  await page.mouse.click(20,20);
  await expect(popup).toHaveCount(0);
});

test("supplement: geometry recorder detects a seeded sizing violation",async({page})=>{
  const popup=await open(page,"card",1920,1080,800,600);
  await popup.locator("img").evaluate(el=>el.style.transform="scale(2)");
  expect((await metrics(popup)).image.width).toBeGreaterThan(800);
  await popup.evaluate(el=>el.style.minWidth="200vw");
  expect((await metrics(popup)).popup.right).toBeGreaterThan(1920);
});

test("supplement: small file image remains painted",async({page})=>{
  const popup=await open(page,"file",1920,1080,64,64);
  await page.screenshot({path:path.join(output,"file-small-painted.png"),animations:"disabled"});
  const data=await popup.locator("img").evaluate((image:HTMLImageElement)=>{
    const canvas=document.createElement("canvas");
    canvas.width=64;canvas.height=64;
    const context=canvas.getContext("2d")!;
    context.drawImage(image,0,0);
    return {pixel:[...context.getImageData(2,2,1,1).data],style:getComputedStyle(image).cssText};
  });
  expect(data.pixel).toEqual([70,130,180,255]);
  writeFileSync(path.join(output,"file-small-painted.json"),JSON.stringify(data,null,2));
});

for(const sample of ["card-image","file-image"]) test(`supplement: actual dialogue sample ${sample}`,async({page})=>{
  await page.setViewportSize({width:1920,height:1080});
  await page.addInitScript(()=>localStorage.setItem("ls.webglGlass","0"));
  await installV3VisualQaRoutes(page);
  await page.goto(`/dialogues?sample=${sample}`);
  const popup=page.locator('[data-slot="dialog-popup"]');
  await expect(popup).toBeVisible();
  await expect(popup).not.toHaveAttribute("data-starting-style");
  await popup.locator("img").evaluate((el:HTMLImageElement)=>el.decode());
  const data=await metrics(popup);
  expect(data.image.width).toBe(data.natural[0]);
  expect(data.image.height).toBe(data.natural[1]);
  expect(data.popup.width).toBe(320);
  await page.screenshot({path:path.join(output,sample+"-dialogues.png"),animations:"disabled"});
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});
