import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { fixtureTitles, installV3VisualQaRoutes } from "./v3-visual-fixtures";

const BASE_URL = process.env.V3_QA_BASE_URL ?? "http://127.0.0.1:4173";
const OUTPUT_ROOT = path.resolve(
  process.env.V3_PROJECT_OUTPUT
    ?? path.join(".local", "artifacts", "screenshots", "pr-t-v3-model-correction"),
);

type Theme = "dark" | "light";

test.use({ serviceWorkers: "allow", timezoneId: "Asia/Seoul" });
test.afterAll(async ({ browser }) => { await browser.close(); });

for (const theme of ["dark", "light"] as const) {
  test(`PR-T · task stars, folder projects, and editable context · ${theme}`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await preparePage(page, theme);
    const state = await installModelCorrectionRoutes(page);

    await page.goto(`${BASE_URL}/v3`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("오늘의 업무")).toBeVisible();
    const reviewPanel = page.getByTestId("v3-session-group-review");
    await expect(reviewPanel.locator(".v3-session-row")).toHaveCount(6);
    await expect(page.getByTestId("v3-navigation-scroll")).not.toContainText("검수 대기");
    await expect(page.locator(".v3-review-strip")).toHaveCount(0);
    await expect(page.getByTestId("v3-starred-tasks")).toContainText(fixtureTitles.primaryTask);
    await expect(page.getByTestId("v3-all-projects").locator(".v3-project-nav-row")).toHaveCount(78);
    await expect(page.getByRole("button", { name: "하위 프로젝트 03", exact: true })).toHaveAttribute("aria-level", "2");
    await expect(page.getByRole("button", { name: /프로젝트.*별표/ })).toHaveCount(0);
    await capture(page, theme, "01-session-panel-folder-projects-and-starred-task");

    const firstReviewTitle = await reviewPanel.locator(".v3-session-open > span:last-child").first().innerText();
    expect(firstReviewTitle).not.toContain("\n");
    expect(Array.from(firstReviewTitle).length).toBeLessThanOrEqual(80);
    await capture(page, theme, "02-right-panel-six-review-sessions");

    const taskCard = page.getByTestId("v3-task-task-alpha");
    await taskCard.getByRole("button", { name: `${fixtureTitles.primaryTask} 별표 해제` }).click();
    await expect(page.getByTestId("v3-starred-tasks")).not.toContainText(fixtureTitles.primaryTask);
    await taskCard.getByRole("button", { name: `${fixtureTitles.primaryTask} 별표 추가` }).click();
    await expect(page.getByTestId("v3-starred-tasks")).toContainText(fixtureTitles.primaryTask);
    expect(state.starVersions).toEqual([4, 5]);
    await capture(page, theme, "03-task-star-round-trip");

    await page.getByTestId("v3-all-projects").getByRole("button", { name: "프로젝트 20", exact: true }).click();
    await expect.poll(() => state.lazyCreateTitles).toEqual(["프로젝트 20"]);
    await expect(page.getByRole("heading", { name: "프로젝트 20" })).toBeVisible();
    await capture(page, theme, "04-lazy-project-created");

    await page.getByTestId("v3-all-projects").getByRole("button", { name: fixtureTitles.project, exact: true }).click();
    await expect(page.getByRole("heading", { name: fixtureTitles.project })).toBeVisible();
    await page.getByRole("button", { name: /리테이크가 필요 없는 완성도/ }).click();
    const guidance = page.getByRole("textbox", { name: "프로젝트 guidance" });
    await guidance.fill("PR-T 저장 왕복 guidance");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("button", { name: /PR-T 저장 왕복 guidance/ })).toBeVisible();
    expect(state.contextVersions).toEqual([4]);
    await capture(page, theme, "05-guidance-edited");

    await page.getByRole("button", { name: /기존 atom · depth 3/ }).click();
    await page.locator(".v3-project-context-editor").getByRole("button").filter({ hasText: "기존 atom" }).click({ timeout: 5_000 });
    await page.getByRole("button", { name: "교정 atom", exact: true }).click();
    await page.getByRole("spinbutton", { name: "깊이" }).fill("5");
    await page.getByRole("checkbox", { name: "제목만 포함" }).check();
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("button", { name: /교정 atom · depth 5 · titlesOnly on/ })).toBeVisible();
    expect(state.contextVersions).toEqual([4, 5]);
    await capture(page, theme, "06-atom-edited");

    await page.getByRole("button", { name: /old-agent@old-node/ }).click();
    await page.getByRole("combobox", { name: "기본 실행 노드" }).selectOption("eiaserinnys");
    await page.getByRole("combobox", { name: "기본 실행 에이전트" }).selectOption("roselin_codex");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    await expect(page.getByRole("button", { name: /roselin_codex@eiaserinnys/ })).toBeVisible();
    expect(state.contextVersions).toEqual([4, 5, 6]);
    await capture(page, theme, "07-default-agent-edited");

    await page.getByRole("button", { name: "아침 정리", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "어제에서 넘어온 것" })).toBeVisible();
    await expect(page.getByText("검수 대기 세션", { exact: true })).toHaveCount(0);
    for (let index = 0; index < 5; index += 1) {
      const remove = page.getByRole("button", { name: "데일리에서 내리기", exact: true });
      if (await remove.count() === 0) break;
      await remove.click();
    }
    const reviewLink = page.getByRole("button", { name: "검수 대기 6건 → 우측 세션" });
    await expect(reviewLink).toBeVisible();
    await capture(page, theme, "08-ritual-task-only-review-link");
    await reviewLink.click();
    await expect(page.getByTestId("v3-session-panel")).toBeFocused();
    await capture(page, theme, "09-session-panel-from-ritual");

    expect(errors).toEqual([]);
  });
}

async function preparePage(page: Page, theme: Theme): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((appearance: Theme) => {
    localStorage.setItem("soul-dashboard-theme", appearance);
    localStorage.setItem("ls.webglGlass", "0");
    const serviceWorker = navigator.serviceWorker;
    if (!serviceWorker) return;
    Object.defineProperty(serviceWorker, "register", {
      configurable: true,
      value: async () => ({ update: async () => undefined, active: null, installing: null, addEventListener: () => undefined, removeEventListener: () => undefined }),
    });
    Object.defineProperty(serviceWorker, "controller", { configurable: true, get: () => null });
  }, theme);
  await installV3VisualQaRoutes(page);
}

async function installModelCorrectionRoutes(page: Page): Promise<{
  starVersions: number[];
  contextVersions: number[];
  lazyCreateTitles: string[];
}> {
  const starVersions: number[] = [];
  const contextVersions: number[] = [];
  const lazyCreateTitles: string[] = [];
  let task = pageDto("task-alpha", fixtureTitles.primaryTask, 4, { starred: true });
  let project = pageDto("project-amber", fixtureTitles.project, 4, { folderId: "folder-amber" });
  let guidance = "리테이크가 필요 없는 완성도를 우선한다.";
  let atom = { nodeId: "old-atom", nodeTitle: "기존 atom", depth: 3, titlesOnly: false };
  let defaults = { agentId: "old-agent", nodeId: "old-node" };
  let lazyProject: ReturnType<typeof pageDto> | null = null;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/folders" && request.method() === "GET") {
      return fulfillJson(route, { folders: projectFolders(), sessions: {} });
    }
    if (url.pathname === "/api/planner/starred-tasks" && request.method() === "GET") {
      return fulfillJson(route, {
        items: task.metadata.starred ? [starredTaskPayload(task)] : [],
        next_cursor: null,
      });
    }
    if (url.pathname === "/api/atom/nodes" && request.method() === "GET") {
      return fulfillJson(route, { children: [{ id: "new-atom", card_id: "card-new-atom", card: { title: "교정 atom", card_type: "knowledge" } }] });
    }
    if (url.pathname === "/api/pages/task-alpha" && request.method() === "GET") {
      return fulfillJson(route, pageRead(task, [{
        id: "task", page_id: task.id, parent_id: null, position_key: "a0", block_type: "task_ref", text: "", properties: { primary: true, taskId: "rb-alpha" }, collapsed: false,
      }]));
    }
    if (url.pathname === "/api/pages/task-alpha/starred" && request.method() === "PATCH") {
      const body = request.postDataJSON() as { expected_version: number; starred: boolean };
      starVersions.push(body.expected_version);
      task = { ...task, version: task.version + 1, metadata: { ...task.metadata, starred: body.starred } };
      return fulfillJson(route, mutation(task, []));
    }
    if (url.pathname === "/api/pages/project-amber" && request.method() === "GET") {
      return fulfillJson(route, pageRead(project, projectContextBlocks(guidance, atom, defaults)));
    }
    if (url.pathname === "/api/pages/project-amber/operations" && request.method() === "POST") {
      const body = request.postDataJSON() as {
        expected_version: number;
        operations: Array<{ block_type?: string; text?: string; properties?: Record<string, unknown> }>;
      };
      contextVersions.push(body.expected_version);
      const operation = body.operations[0];
      if (operation?.text !== undefined) guidance = operation.text;
      if (operation?.block_type === "atom_ref") {
        atom = {
          nodeId: String(operation.properties?.nodeId ?? atom.nodeId),
          nodeTitle: String(operation.properties?.nodeTitle ?? atom.nodeTitle),
          depth: Number(operation.properties?.depth ?? atom.depth),
          titlesOnly: Boolean(operation.properties?.titlesOnly),
        };
      }
      if (operation?.block_type === "session_defaults") {
        defaults = {
          agentId: String(operation.properties?.agentId ?? ""),
          nodeId: String(operation.properties?.nodeId ?? ""),
        };
      }
      project = { ...project, version: project.version + 1 };
      return fulfillJson(route, mutation(project, projectContextBlocks(guidance, atom, defaults)));
    }
    if (/^\/api\/pages\/daily-[^/]+\/operations$/.test(url.pathname) && request.method() === "POST") {
      const body = request.postDataJSON() as { operations: Array<{ temp_id?: string }> };
      const tempId = body.operations[0]?.temp_id ?? "lazy-seed";
      return fulfillJson(route, {
        ...mutation(pageDto("daily-2026-07-14", "2026-07-14", 5, {}), []),
        temp_id_mapping: { [tempId]: "lazy-seed-block" },
      });
    }
    if (url.pathname === "/api/pages/block-transfers" && request.method() === "POST") {
      const body = request.postDataJSON() as { target: { page_id: string; title: string } };
      lazyCreateTitles.push(body.target.title);
      lazyProject = pageDto(body.target.page_id, body.target.title, 1, {});
      return fulfillJson(route, {
        source: mutation(pageDto("daily-2026-07-14", "2026-07-14", 6, {}), []),
        target: mutation(lazyProject, []),
        target_created: true,
      });
    }
    if (lazyProject && url.pathname === `/api/pages/${lazyProject.id}` && request.method() === "GET") {
      return fulfillJson(route, pageRead(lazyProject, []));
    }
    if (lazyProject && url.pathname === `/api/planner/projects/${lazyProject.id}` && request.method() === "GET") {
      return fulfillJson(route, {
        project: lazyProject,
        tasks: { items: [], next_cursor: null },
        documents: { items: [], next_cursor: null },
      });
    }
    return route.fallback();
  });
  return { starVersions, contextVersions, lazyCreateTitles };
}

function projectFolders() {
  return [
    { id: "folder-amber", name: fixtureTitles.project, sortOrder: 0, parentFolderId: null },
    { id: "folder-ops", name: "Soulstream 운영", sortOrder: 1, parentFolderId: null },
    ...Array.from({ length: 76 }, (_, index) => ({
      id: `folder-extra-${index + 3}`,
      name: index === 0 ? "하위 프로젝트 03" : `프로젝트 ${String(index + 3).padStart(2, "0")}`,
      sortOrder: index + 2,
      parentFolderId: index < 12 ? "folder-amber" : null,
    })),
  ];
}

function guidanceBlock(text: string) {
  return { id: "project-guidance", page_id: "project-amber", parent_id: null, position_key: "a0", block_type: "guidance", text, properties: { enabled: true, scope: "project" }, collapsed: false };
}

function projectContextBlocks(
  guidance: string,
  atom: { nodeId: string; nodeTitle: string; depth: number; titlesOnly: boolean },
  defaults: { agentId: string; nodeId: string },
) {
  return [
    guidanceBlock(guidance),
    { id: "project-atom", page_id: "project-amber", parent_id: null, position_key: "a1", block_type: "atom_ref", text: "", properties: { instance: "atom", ...atom }, collapsed: false },
    { id: "project-defaults", page_id: "project-amber", parent_id: null, position_key: "a2", block_type: "session_defaults", text: "", properties: { scope: "project", ...defaults }, collapsed: false },
  ];
}

function pageDto(id: string, title: string, version: number, metadata: Record<string, unknown>) {
  return { id, title, daily_date: null, version, archived: false, metadata, created_at: "2026-07-14T00:00:00Z", updated_at: "2026-07-14T00:00:00Z" };
}

function pageRead(value: ReturnType<typeof pageDto>, blocks: ReturnType<typeof guidanceBlock>[] | Array<Record<string, unknown>>) {
  return { page: value, blocks, state_vector: "AA==" };
}

function starredTaskPayload(task: ReturnType<typeof pageDto>) {
  const taskBlock = {
    id: "task",
    page_id: task.id,
    parent_id: null,
    position_key: "a0",
    block_type: "task_ref",
    text: "",
    properties: { primary: true, taskId: "rb-alpha" },
    collapsed: false,
  };
  return {
    page: task,
    blocks: [taskBlock],
    task_id: "rb-alpha",
    task: {
      id: "rb-alpha",
      board_item_id: "board-task-alpha",
      title: task.title,
      status: "open",
      archived: false,
      version: 1,
      created_session_id: null,
      created_event_id: null,
      created_at: task.created_at,
      updated_at: task.updated_at,
      item_counts: {},
      item_total: 0,
      completed_item_count: 0,
      assignee: null,
    },
    project_page_id: "project-amber",
    sessions: [],
    mounted_documents: [],
  };
}

function mutation(value: ReturnType<typeof pageDto>, blocks: Array<Record<string, unknown>>) {
  return { page: value, blocks, operation: { id: `operation-${value.id}-${value.version}` }, temp_id_mapping: {} };
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function capture(page: Page, theme: Theme, state: string): Promise<void> {
  const output = path.join(OUTPUT_ROOT, theme);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `${state}.png`), fullPage: false, animations: "disabled" });
}
