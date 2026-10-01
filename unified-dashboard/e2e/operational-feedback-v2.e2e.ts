import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";
import { reviewCard } from "../client/v3/components-review-fixtures";

const output = path.resolve("../../../.local/artifacts/20261001-web-ui-v2");
const phase = process.env.COMPONENTS_REVIEW_PHASE;
if (!phase) throw new Error("COMPONENTS_REVIEW_PHASE required");
mkdirSync(output, { recursive: true });

for (const width of [1440, 390]) test(`operational row comparison ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
    localStorage.setItem("soul-user-preferences:qa@example.test", JSON.stringify({ chatFontSize: 17 }));
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1 });
  await page.route("**/api/auth/config", r => r.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", r => r.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.route("**/api/user/preferences", r => r.fulfill({ json: { preferences: { chatFontSize: 17 }, hasBackground: false } }));
  const capture=async(name:string)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,`${phase}-${width}-${name}.png`),animations:"disabled"});};
  const cards = ["blocked", "review"].map((status, i) => ({ ...reviewCard, status, id: `qa-state-${status}`, folderId: "folder-amber", assigneeSessionId: null, positionKey: String(i), title: "상태별 같은 카드", request: "같은 미리보기" }));
  await page.route("**/api/cards?**", r => r.fulfill({ json: { cards: new URL(r.request().url()).searchParams.get("folderId") === "folder-amber" ? cards : [] } }));
  await page.route("**/api/cards/qa-state-*", r => {
    const card = cards.find(card => r.request().url().endsWith(card.id));
    return r.fulfill({ json: { card, reports: [], questions: [], sessions: [], comments: [] } });
  });
  await page.goto("/");
  let dailyView,dailyEdit;
  if(!process.env.ROWS_ONLY) {
  const daily=page.locator(".v3-daily-memo");
  await expect(daily).toBeVisible(); await capture("operational-daily-view");
  const dailySurface = async()=>daily.locator(".v3-description-preview,.v3-description-editor").first().evaluate(el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return {x:r.x,w:r.width,padding:s.padding,radius:s.borderRadius,background:s.backgroundColor};});
  dailyView=await dailySurface();
  await daily.getByRole("button",{name:"오늘 메모 편집",exact:true}).first().click();
  dailyEdit=await dailySurface(); await capture("operational-daily-edit");
  if(phase!=="baseline") expect.soft(dailyEdit).toEqual(dailyView);
  await page.getByLabel("오늘 메모 마크다운").press("Control+Enter");
  if(width>=760) {const review=page.getByTestId("v3-session-group-review");await review.scrollIntoViewIfNeeded();await capture("operational-review-sessions");}

  }
  if (width < 760) {
    await page.getByTestId("v3-mobile-tab-projects").click();
    await page.getByTestId("v3-mobile-project-list").getByRole("button", { name: "소울스트림", exact: true }).click();
  } else await page.getByTestId("v3-all-projects").getByRole("button", { name: "소울스트림", exact: true }).click();
  const context = page.getByTestId("v3-project-context");
  await expect(context).toBeVisible(); await capture("operational-folder");
  await context.scrollIntoViewIfNeeded(); await capture("operational-context");
  await page.locator(".v3-child-folders").scrollIntoViewIfNeeded(); await capture("operational-subfolders");
  const operationalCards = page.getByTestId('v3-folder-cards-section').locator('.v3-card-row[data-card-id^="qa-state-"]');
  await expect(operationalCards).toHaveCount(2);
  await operationalCards.first().scrollIntoViewIfNeeded(); await capture("operational-card-states");
  const operationalActions = await operationalCards.evaluateAll(rows => rows.map(row => {
    const action = row.querySelector(".dashboard-icon-cap")!.getBoundingClientRect(), r = row.getBoundingClientRect();
    return { width: action.width, height: action.height, rightInset: r.right - action.right, rowHeight: r.height };
  }));
  if(phase!=="baseline") expect.soft(operationalActions[0]).toEqual(operationalActions[1]);
  await page.getByTestId("v3-task-project-dashboard").locator("strong,h3").click();
  const emptyContext=page.getByTestId("v3-project-context");
  await expect(emptyContext).toBeVisible(); await emptyContext.scrollIntoViewIfNeeded(); await capture("operational-empty-context-parent");
  writeFileSync(path.join(output, `${phase}-${width}-operational-metrics.json`),JSON.stringify({dailyView,dailyEdit,operationalActions},null,2));
});
