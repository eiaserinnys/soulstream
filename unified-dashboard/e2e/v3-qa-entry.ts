import type { Page } from "@playwright/test";

/**
 * v3 QA 공용 진입 도우미.
 *
 * /v3 첫 화면은 CardHome이고, 폴더 카드(v3-task-*)는 폴더 화면의 하위 폴더
 * 목록에서만 그려진다. QA가 예전 첫 화면(일일 플래너)의 카드나 폴더 화면을
 * 기다리며 멈추지 않도록 진입을 이 두 함수로 모은다.
 */

export const V3_QA_DEFAULT_FOLDER_ID = "folder-amber";

/** `/v3` → CardHome → 전체 프로젝트의 폴더 행 → 폴더 화면. */
export async function openV3Folder(
  page: Page,
  baseUrl: string,
  folderId: string = V3_QA_DEFAULT_FOLDER_ID,
): Promise<void> {
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("card-home").waitFor({ state: "visible", timeout: 30_000 });
  const row = page.getByTestId(`v3-project-row-${folderId}`);
  await row.waitFor({ state: "attached", timeout: 30_000 });
  if (await row.isVisible()) {
    await row.locator(".v3-project-nav-link").click();
  } else {
    // 모바일 레이아웃은 내비게이션 대신 프로젝트 목록 탭을 쓴다.
    const name = await row.locator(".v3-project-nav-link").getAttribute("aria-label");
    await page.getByTestId("v3-mobile-tab-projects").click();
    await page.getByTestId("v3-mobile-project-list")
      .getByRole("button", { name: name ?? folderId, exact: true }).click();
  }
  await page.getByTestId("v3-folder-cards-section").waitFor({ state: "visible", timeout: 30_000 });
}

export async function openV3Home(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/v3`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("card-home").waitFor({ state: "visible", timeout: 30_000 });
}
