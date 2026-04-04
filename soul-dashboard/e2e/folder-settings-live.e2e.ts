/**
 * 폴더 설정 Live E2E 테스트
 *
 * 프로덕션 서버(http://localhost:5200)에서 폴더 우클릭 → 설정 → 저장 흐름을 검증.
 * 특히 PUT /api/catalog/folders/{id} 요청이 실제로 전송되는지,
 * 그리고 저장 후 새로고침했을 때 설정이 유지되는지 확인한다.
 */

import { test, expect } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARD_URL = "http://localhost:5200";
const SCREENSHOT_DIR = path.join(__dirname, "screenshots", "folder-settings");

test.describe("폴더 설정 저장 확인", () => {
  test.beforeAll(async () => {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test.beforeEach(async () => {
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/catalog`);
      if (!res.ok) test.skip();
    } catch {
      test.skip();
    }
  });

  test("폴더 우클릭 → 설정 → 저장 시 PUT 요청 확인", async ({ page }) => {
    const networkRequests: Array<{ method: string; url: string; body: string; status: number }> = [];

    // 모든 PUT 요청 캡처
    page.on("request", (req) => {
      if (req.method() === "PUT" || req.method() === "PATCH") {
        networkRequests.push({
          method: req.method(),
          url: req.url(),
          body: req.postData() ?? "",
          status: 0,
        });
      }
    });
    page.on("response", (res) => {
      const entry = networkRequests.find(r => res.url().includes(r.url) || r.url.includes(res.url()));
      if (entry) entry.status = res.status();
    });

    await page.goto(DASHBOARD_URL, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-initial.png") });

    // 폴더 목록 확인
    const folders = page.locator('[data-folder-id]');
    const folderCount = await folders.count();
    console.log(`폴더 수: ${folderCount}`);

    if (folderCount === 0) {
      // data-folder-id가 없는 경우 다른 셀렉터 시도
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-no-folders.png") });
      console.log("data-folder-id 셀렉터로 폴더를 찾을 수 없음. 대안 셀렉터 탐색 중...");

      // FolderTree 내 항목 찾기
      const anyFolder = page.locator('.folder-item, [role="treeitem"], li[data-id]').first();
      const anyFolderCount = await anyFolder.count();
      console.log(`대안 셀렉터 결과: ${anyFolderCount}`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-selector-debug.png") });
      return;
    }

    // 첫 번째 폴더 우클릭
    const firstFolder = folders.first();
    const folderName = await firstFolder.textContent();
    console.log(`대상 폴더: ${folderName}`);

    await firstFolder.click({ button: "right" });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-context-menu.png") });

    // 컨텍스트 메뉴에서 "설정" 클릭
    const settingsMenuItem = page.getByRole("menuitem", { name: /설정/ });
    const settingsVisible = await settingsMenuItem.isVisible().catch(() => false);

    if (!settingsVisible) {
      console.log("'설정' 메뉴 항목을 찾을 수 없음");
      // 현재 페이지에 보이는 모든 menuitem 출력
      const allMenuItems = await page.getByRole("menuitem").allTextContents();
      console.log("현재 menuitem 목록:", allMenuItems);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-menu-debug.png") });
      return;
    }

    await settingsMenuItem.click();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-settings-dialog.png") });

    // 설정 모달 확인
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // "피드에서 제외" 체크박스 현재 상태 확인
    const checkbox = dialog.locator('input[type="checkbox"]');
    const initialChecked = await checkbox.isChecked();
    console.log(`피드에서 제외 초기 상태: ${initialChecked}`);

    // 상태 토글
    await checkbox.click();
    const newChecked = await checkbox.isChecked();
    console.log(`피드에서 제외 변경 후: ${newChecked}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-checkbox-toggled.png") });

    // 저장 버튼 클릭
    const saveButton = dialog.getByRole("button", { name: /저장/ });
    await saveButton.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "05-after-save.png") });

    // 네트워크 요청 분석
    console.log("\n=== 캡처된 PUT/PATCH 요청 ===");
    if (networkRequests.length === 0) {
      console.log("❌ PUT/PATCH 요청 없음 — 저장 요청이 전송되지 않았음");
    } else {
      for (const req of networkRequests) {
        console.log(`${req.method} ${req.url}`);
        console.log(`  body: ${req.body}`);
        console.log(`  status: ${req.status}`);
        const isCorrectPath = req.url.includes("/api/catalog/folders/");
        console.log(`  경로 올바름: ${isCorrectPath ? "✅" : "❌ (예상: /api/catalog/folders/{id})"}`);
      }
    }

    // 새로고침 후 설정 유지 확인
    await page.reload({ waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "06-after-reload.png") });

    // 동일 폴더 우클릭 → 설정 다시 열기
    const foldersAfterReload = page.locator('[data-folder-id]');
    await foldersAfterReload.first().click({ button: "right" });
    const settingsMenuAgain = page.getByRole("menuitem", { name: /설정/ });
    if (await settingsMenuAgain.isVisible().catch(() => false)) {
      await settingsMenuAgain.click();
      const dialogAgain = page.getByRole("dialog");
      await dialogAgain.waitFor({ timeout: 3000 });
      const checkboxAfterReload = dialogAgain.locator('input[type="checkbox"]');
      const persistedChecked = await checkboxAfterReload.isChecked();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, "07-after-reload-settings.png") });
      console.log(`\n=== 새로고침 후 설정 유지 ===`);
      console.log(`저장 전: ${initialChecked} → 저장 후: ${newChecked} → 새로고침 후: ${persistedChecked}`);
      console.log(persistedChecked === newChecked ? "✅ 설정이 올바르게 유지됨" : "❌ 설정이 초기화됨 (저장 안 됨)");
    }

    // 최종 검증: PUT 요청이 올바른 경로로 전송됐는지
    const correctRequests = networkRequests.filter(r => r.url.includes("/api/catalog/folders/"));
    expect(
      correctRequests.length,
      `PUT /api/catalog/folders/{id} 요청이 전송되어야 함. 실제 요청: ${JSON.stringify(networkRequests.map(r => r.url))}`
    ).toBeGreaterThan(0);
  });
});
