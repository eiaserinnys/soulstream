import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.V3_PROJECT_OUTPUT
    ?? path.join(".local", "artifacts", "screenshots", "pr-k-v3-project-star-entry"),
);
const PROJECT_TITLE = "QA 별표 프로젝트";

type Theme = "dark" | "light";

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });

for (const theme of ["dark", "light"] as const) {
  test(`project creation and star controls · ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await preparePage(page, theme);
    const mutationState = await installProjectMutationRoutes(page);
    page.on("dialog", (dialog) => { void dialog.accept(); });

    await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("오늘의 업무")).toBeVisible();

    await page.getByRole("button", { name: "＋ 새 프로젝트" }).click();
    await page.getByRole("textbox", { name: "새 프로젝트 제목" }).fill(PROJECT_TITLE);
    await page.getByRole("button", { name: "만들기" }).click();

    const projectLinks = page.locator("button.v3-project-nav-link").filter({ hasText: PROJECT_TITLE });
    await expect(projectLinks).toHaveCount(2, { timeout: 15_000 });
    const projectLink = projectLinks.first();
    await capture(page, `${theme}-01-created.png`);

    await page.evaluate((title) => {
      const project = [...document.querySelectorAll<HTMLButtonElement>("button.v3-project-nav-link")]
        .find((button) => button.textContent?.replace("◆", "").trim() === title);
      if (!project) throw new Error(`프로젝트 링크를 찾지 못했습니다: ${title}`);
      project.click();
    }, PROJECT_TITLE);
    await expect.poll(() => mutationState.plannerProjectIds.at(-1)).toBe(mutationState.createdProjectId());
    await expect(page.getByRole("heading", { name: PROJECT_TITLE })).toBeVisible();
    await expect(page.getByRole("button", { name: "★ 별표됨" })).toBeVisible();

    const navigationRow = projectLink.locator("..");
    await navigationRow.hover();
    const navigationUnstar = page.getByRole("button", { name: `${PROJECT_TITLE} 별표 해제` }).first();
    await expect(navigationUnstar).toHaveCSS("opacity", "1");
    await navigationUnstar.dispatchEvent("click");
    await expect(projectLinks).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "☆ 별표하기" })).toBeVisible({ timeout: 15_000 });
    await capture(page, `${theme}-02-unstarred.png`);

    await page.getByRole("button", { name: "☆ 별표하기" }).dispatchEvent("click");
    await expect(projectLinks).toHaveCount(2, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "★ 별표됨" })).toBeVisible({ timeout: 15_000 });
    await capture(page, `${theme}-03-restarred.png`);

    await page.getByRole("button", { name: "★ 별표됨" }).dispatchEvent("click");
    await expect(page.getByRole("button", { name: "☆ 별표하기" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "☆ 별표하기" }).dispatchEvent("click");
    await expect(page.getByRole("button", { name: "★ 별표됨" })).toBeVisible({ timeout: 15_000 });

    expect(mutationState.casVersions).toEqual([1, 2, 3, 4, 5]);
    expect(errors).toEqual([]);
  });
}

async function preparePage(page: Page, theme: Theme): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((appearance: Theme) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("soul-wallpaper", JSON.stringify({ mode: "bokeh" }));
    localStorage.setItem("ls.webglGlass", "false");
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(serviceWorker, "controller", {
      configurable: true,
      get: () => null,
    });
  }, theme);
  await installV3VisualQaRoutes(page);
}

async function installProjectMutationRoutes(page: Page): Promise<{
  casVersions: number[];
  plannerProjectIds: string[];
  createdProjectId(): string | null;
}> {
  const casVersions: number[] = [];
  const plannerProjectIds: string[] = [];
  let createdPage: ReturnType<typeof pageDto> | null = null;
  const starredIds = new Set(["project-amber", "project-ops"]);

  await page.route("**/api/planner/projects/**", async (route) => {
    const request = route.request();
    const apiPath = new URL(request.url()).pathname;
    const createdPlannerMatch = /^\/api\/planner\/projects\/([^/]+)$/.exec(apiPath);
    if (!createdPlannerMatch || request.method() !== "GET") return route.fallback();
    const projectId = decodeURIComponent(createdPlannerMatch[1]);
    plannerProjectIds.push(projectId);
    if (createdPage?.id !== projectId) return route.fallback();
    return fulfillJson(route, {
      project: createdPage,
      tasks: { items: [], next_cursor: null },
      documents: { items: [], next_cursor: null },
    });
  });

  await page.route("**/api/pages**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const apiPath = url.pathname;

    if (apiPath === "/api/pages" && request.method() === "GET" && url.searchParams.get("starred") === "true" && createdPage) {
      const baseProjects = [
        pageDto("project-amber", "Amber & Blade", 4, { folderId: "folder-amber", starred: true }),
        pageDto("project-ops", "Soulstream 운영", 4, { folderId: "folder-ops", starred: true }),
      ];
      const items = [...baseProjects, createdPage].filter((candidate) => starredIds.has(candidate.id));
      return fulfillJson(route, { items, next_cursor: null });
    }

    if (/^\/api\/pages\/[^/]+\/operations$/.test(apiPath) && request.method() === "POST") {
      const body = request.postDataJSON() as {
        operations?: Array<{ temp_id?: string }>;
      };
      const tempId = body.operations?.[0]?.temp_id ?? "seed";
      return fulfillJson(route, mutation(
        pageDto("daily-2026-07-14", "2026-07-14", 5),
        { [tempId]: "seed-block" },
      ));
    }

    if (apiPath === "/api/pages/block-transfers" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        target: { kind: "new"; page_id: string; title: string };
      };
      createdPage = pageDto(body.target.page_id, body.target.title, 1);
      return fulfillJson(route, {
        source: mutation(pageDto("daily-2026-07-14", "2026-07-14", 6)),
        target: mutation(createdPage),
        target_created: true,
      });
    }

    const createdReadMatch = /^\/api\/pages\/([^/]+)$/.exec(apiPath);
    if (createdReadMatch && request.method() === "GET" && createdPage?.id === decodeURIComponent(createdReadMatch[1])) {
      return fulfillJson(route, { page: createdPage, blocks: [], state_vector: "AA==" });
    }

    const starMatch = /^\/api\/pages\/([^/]+)\/starred$/.exec(apiPath);
    if (starMatch && request.method() === "PATCH" && createdPage?.id === decodeURIComponent(starMatch[1])) {
      const body = request.postDataJSON() as { starred: boolean; expected_version: number };
      casVersions.push(body.expected_version);
      if (body.expected_version !== createdPage.version) {
        return fulfillJson(route, { detail: "version conflict" }, 409);
      }
      createdPage = {
        ...createdPage,
        version: createdPage.version + 1,
        metadata: { ...createdPage.metadata, starred: body.starred },
      };
      if (body.starred) starredIds.add(createdPage.id);
      else starredIds.delete(createdPage.id);
      return fulfillJson(route, mutation(createdPage));
    }

    return route.fallback();
  });

  return {
    casVersions,
    plannerProjectIds,
    createdProjectId: () => createdPage?.id ?? null,
  };
}

function pageDto(
  id: string,
  title: string,
  version: number,
  metadata: Record<string, unknown> = {},
) {
  return {
    id,
    title,
    daily_date: null,
    version,
    archived: false,
    metadata,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  };
}

function mutation(value: ReturnType<typeof pageDto>, tempIdMapping: Record<string, string> = {}) {
  return {
    page: value,
    blocks: [],
    operation: { id: `operation-${value.id}-${value.version}` },
    temp_id_mapping: tempIdMapping,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function capture(page: Page, filename: string): Promise<void> {
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  await page.evaluate(async () => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await page.screenshot({
    path: path.join(OUTPUT_ROOT, filename),
    fullPage: false,
    animations: "disabled",
  });
}
