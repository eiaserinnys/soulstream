// 지침과 스킬 보기 시각 검수(agent-profile-assembly-guides.e2e.ts)의 공통 도구.
import { expect, type Page } from "@playwright/test";
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

/** 캡처와 조작 결과는 워크트리 맨 위 .local/shots/에 둔다(git이 무시한다). */
export const shots = path.resolve("../.local/shots");
export const operationsFile = path.join(shots, "operations.md");
/** 시험이 쓰는 앞부분. 마지막에 globalTeardown이 검수 지적 측정(fixes.json)을 붙여 operations.md로 합친다. */
export const operationsMainFile = path.join(shots, "operations-main.md");

export type Theme = "light" | "dark";
export interface OpenOptions {
  width: number;
  height: number;
  theme?: Theme;
  /** 설정 창 왼쪽 목록에서 누를 항목. */
  category: "에이전트" | "스킬과 카탈로그";
  assemblyState?: string;
  guidesState?: string;
}

export const WIDE = { width: 1440, height: 900 } as const;
export const NARROW = { width: 360, height: 800 } as const;

export async function openSettings(page: Page, options: OpenOptions) {
  const theme = options.theme ?? "light";
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((value) => { localStorage.setItem("soul-dashboard-theme", value); localStorage.setItem("ls.webglGlass", "0"); }, theme);
  await installV3VisualQaRoutes(page);
  await page.route("**/api/**", route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/config") return route.fulfill({ json: { authEnabled: true, devModeEnabled: false } });
    if (pathname === "/api/auth/status") return route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } });
    if (pathname === "/api/ui-events/config") return route.fulfill({ json: { enabled: false, flushIntervalMs: 1000, maxBatchSize: 1, maxQueueSize: 500, schemaVersion: "soulstream.ui_event.v1" } });
    if (pathname === "/api/health") return route.fulfill({ json: { healthy: true, ready: true, draining: false, build_id: "dev" } });
    if (pathname === "/api/nodes") return route.fulfill({ json: { nodes: [] } });
    if (pathname === "/api/nodes/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: snapshot\ndata: []\n\n" });
    if (pathname === "/api/sessions/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: session_list\ndata: {"type":"session_list","sessions":[],"total":0}\n\n' });
    if (pathname.endsWith("/stream") || pathname.endsWith("/events")) return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": empty\n\n" });
    return route.fulfill({ status: 200, json: {} });
  });
  const query = new URLSearchParams({ sample: "settings", assemblyState: options.assemblyState ?? "normal", guidesState: options.guidesState ?? "normal" });
  await page.goto(`/dialogues?${query}`);
  await expect(page.getByRole("heading", { name: "설정", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: options.category, exact: true }).click();
}

/** 컴포넌트 검수 창(/components)을 연다. 표본 부품은 모두 자기 가짜 응답으로 선다. */
export async function openComponents(page: Page, theme: Theme) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((value) => { localStorage.setItem("soul-dashboard-theme", value); localStorage.setItem("ls.webglGlass", "0"); }, theme);
  await installV3VisualQaRoutes(page, { unifiedFolderView: true, timelineEventCount: 1, liveEventText: "채팅의 기존 본문과 입력창입니다." });
  await page.route("**/api/auth/config", route => route.fulfill({ json: { authEnabled: true, devModeEnabled: false } }));
  await page.route("**/api/auth/status", route => route.fulfill({ json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } } }));
  await page.goto("/components");
  await expect(page.getByTestId("components-review")).toBeVisible({ timeout: 30_000 });
}

/** 표본 하나(Sample의 data-component 머리말)를 화면에 올려 그 칸만 캡처한다. */
export async function shotSample(page: Page, componentPrefix: string, relative: string) {
  const sample = page.locator(`[data-component^="${componentPrefix}"]`);
  // 검수 창은 구역을 이어서 그린다. 표본이 DOM에 설 때까지 기다린 뒤 화면에 올린다.
  await expect(sample).toBeAttached({ timeout: 30_000 });
  await sample.scrollIntoViewIfNeeded();
  await expect(sample).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(shots, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  await sample.screenshot({ path: file, animations: "disabled" });
  return file;
}

export async function shot(page: Page, relative: string) {
  const file = path.join(shots, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, animations: "disabled" });
  return file;
}

/** 조작 측정 한 줄을 operations 원자료(.local/shots/operations-raw.jsonl)에 덧붙인다. 요약 표는 operations.md에 손으로 정리한다. */
export function note(key: string, value: unknown) {
  mkdirSync(shots, { recursive: true });
  appendFileSync(path.join(shots, "operations-raw.jsonl"), `${JSON.stringify({ key, value })}\n`);
  console.log(`${key}: ${JSON.stringify(value)}`);
}

export function resetRaw() {
  mkdirSync(shots, { recursive: true });
  writeFileSync(path.join(shots, "operations-raw.jsonl"), "");
}

export const hasOperations = () => existsSync(operationsFile);

/** 페이지 가로 스크롤이 없는지와, 보이는 글이 0폭이거나 겹치지 않는지의 기본 측정. */
export async function pageOverflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const dialog = document.querySelector<HTMLElement>(".config-dialog");
    const detail = document.querySelector<HTMLElement>(".config-detail");
    return {
      pageScrollWidth: doc.scrollWidth, pageClientWidth: doc.clientWidth,
      dialogScrollWidth: dialog?.scrollWidth ?? 0, dialogClientWidth: dialog?.clientWidth ?? 0,
      detailScrollWidth: detail?.scrollWidth ?? 0, detailClientWidth: detail?.clientWidth ?? 0,
    };
  });
}

/** 구성 화면의 소스 줄은 눌러 펴는 줄이라 본문은 줄 끝의 「본문 보기」로 연다. */
export async function openBody(page: Page, title: string) {
  const assembly = page.getByTestId("agent-context-assembly");
  const body = assembly.locator(`button[aria-label*="${title}"][aria-label$="본문 보기"]`);
  // 좁은 칸에서는 「본문 보기」가 펼친 트리 머리에 있으니 먼저 소스 줄을 편다.
  if (!(await body.isVisible())) await assembly.locator("button[aria-expanded]", { hasText: title }).first().click();
  await body.click();
}

const fixesFile = path.join(shots, "fixes.json");
/** 검수 지적 완료 조건 측정 결과(한 줄씩)를 남긴다. operations 시험이 읽어 operations.md에 적는다. */
export function writeFixes(lines: string[]) {
  mkdirSync(shots, { recursive: true });
  writeFileSync(fixesFile, JSON.stringify(lines, null, 2));
}
const readFixes = (): string[] => existsSync(fixesFile) ? JSON.parse(readFileSync(fixesFile, "utf8")) as string[] : [];

const FIXES_MARK = "<!--FIXES-->";
/** operations-main.md의 자리표시를 검수 지적 측정으로 바꿔 operations.md를 쓴다. 두 시험이 모두 끝난 뒤에 부른다. */
export function composeOperations() {
  if (!existsSync(operationsMainFile)) return;
  const fixes = readFixes();
  const body = fixes.length > 0 ? fixes.map(line => `- ${line}`).join("\n") : "(이번 실행에서 재지 않음)";
  writeFileSync(operationsFile, readFileSync(operationsMainFile, "utf8").replace(FIXES_MARK, body));
}

export interface OperationResults {
  /** [대상, 한 일, 결과] */
  focus: string[][];
  tab: string[];
  overflow: string[];
  errors: string[];
  resize: string[];
  /** [대상, 여는 법, 첫 초점, Enter, Esc, 닫은 뒤 초점] */
  dialogs: string[][];
}

const bullet = (lines: string[]) => lines.map(line => `- ${line}`).join("\n");

/** 측정한 조작 결과와 정적 목록을 ui-design §9의 꼴로 .local/shots/operations.md에 쓴다. */
export function writeOperations(out: OperationResults) {
  const table = (rows: string[][], header: string[]) => [
    `| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map(row => `| ${row.join(" | ")} |`),
  ].join("\n");
  const text = `# 카드 #1854 지침과 스킬 보기 조작 결과 (단위 card1854-guides-ui)

이 파일은 시각 검수 스크립트(\`e2e/agent-profile-assembly-guides.e2e.ts\`의 operations 시험)가 재서 쓴다. 손으로 고치지 않는다.

## 14번부터 18번

| 번호 | 결과 | 근거 |
| --- | --- | --- |
| 14 누른 뒤 초점 | 통과 | ${out.focus.map(row => `${row[0]}: ${row[1]} → ${row[2]}`).join(" / ")} |
| 15 Tab과 Esc | 통과 | 「다시 검증」에서 Tab 14번을 눌러 지나간 정지점이 모두 화면에 보이는 요소다: ${out.tab.join(", ")}. Esc는 설정 창을 닫는다(기존 동작, 이 화면에 새 대화상자 팝오버 메뉴 없음) |
| 16 최소 폭 360 | 통과 | ${out.overflow.join(" / ")} |
| 17 오류 상태 | 통과 | ${out.errors.join(" / ")} |
| 18 창 크기 바꾸기 | 통과 | ${out.resize.join(" / ")} |

## 대화상자와 줄 안 편집

이 화면들에 새 대화상자, 시트, 팝오버, 메뉴, 줄 안 편집은 없다(편집은 범위 밖). 아래는 같은 자리에서 바뀌는 전환(펼침, 상세, 단추)을 같은 칸 모양으로 잰 것이다.

${table(out.dialogs, ["대상", "여는 법", "첫 초점", "Enter", "Esc", "닫은 뒤 초점"])}

## 검수 지적 완료 조건(세라피엘 화면 검수 b2552487, 결함 여섯과 권함 둘, 못 본 것 둘)

시각 검수 스크립트의 fixes 시험이 아래를 재고 판정했다(조건을 못 채우면 시험이 실패한다).

${FIXES_MARK}

## 실행 명령과 산출물 경로

- 실행: \`corepack pnpm -C unified-dashboard exec playwright test --config playwright.agent-profile-assembly.config.ts\` (이 파일은 그 안의 \`agent-profile-assembly-guides.e2e.ts\` operations 시험이 쓴다)
- 캡처: \`.local/shots/{profile,skills,overview}-{wide,narrow}.png\`(밝은 테마, 1440x900과 360x800), \`.local/shots/dark/\`(어두운 테마 같은 여섯), \`.local/shots/states/\`(로딩, 오류, 빈 상태, 보고에 없음, 검증 중, 오류 열, 카탈로그 상세, 본문 탭과 그 밖의 상태)
- 견본 응답: \`client/v3/dialogues-api.ts\`의 분기와 \`client/v3/guides-api.ts\`, \`client/v3/guides-fixture.ts\`(지어낸 이름. 프로필 18개 중앙 11 노드 설정 7, 스킬 180, 카탈로그 27, 가장 긴 이름과 설명, 진단 섞임)

## 재사용한 부품과 토큰, 새로 적은 px 값

- 부품: \`SettingsListDetailFrame\`, \`SettingsListHeader\`, \`SettingsListSection\`, \`SettingsListRow\`, \`SettingsDetailHeader\`, \`SettingsGroupBox\`(설정 탭의 목록과 상세 틀). 변형 \`fill\`, \`detailOpen\`, \`titleBadge\`, \`inlineActions\`만 더했다.
- \`DetailTabs\`(탭), \`Button\`, \`Badge\`, \`DashboardIconCap\`, \`FrameLoading\`, \`FrameNotice\`, \`ContextContentRenderer\`, v3 스켈레톤(\`v3-run-skeleton\`).
- 토큰: \`--v3-space-1\`부터 \`--v3-space-8\`, \`--v3-type-body\`, \`--v3-type-meta\`, \`--v3-action-size\`, \`--radius-floor\`, \`--border\`, \`--muted-foreground\`, \`--foreground\`, \`--control-surface\`, \`--destructive-foreground\`, \`--container-sm\`.
- 새로 적은 px 값: 없음(표 칸 폭, 머리 높이, 줄 이름 최소 폭은 \`--v3-space-*\`의 곱이다).

## 화면에 둔 글과 §0 9번 판정

${bullet([
  "구성: 「구성」(탭 이름, 옛 「조립」), 「본문 보기」(아이콘 단추 이름), 「스킬」(구역 머리), 「본문까지·이름과 설명만·제목만」(실린 방식), 「프로필 몫만 보입니다. 폴더, 페이지, 세션이 붙이는 글은 빠집니다.」(메타 한 줄). 줄인 글: 옛 안내 두 문장을 한 줄 메타로 줄였다. 덜 띄운 글: 실린 방식은 모두 같으면 구역 머리에 한 번만 적고 줄마다 적지 않는다. 빈 문서 안내는 줄을 펼쳤을 때만 보인다.",
  "스킬과 카탈로그: 「검증 보고 없음」과 「N월 N일 HH:MM 검증」(보고 시각은 늘 필요한 정보), 「다시 검증」, 「검증 중」, 「검증 작업이 없습니다」(409의 그 자리 안내), 탭 「스킬·카탈로그」, 「경고 있는 것만」, 「프로필 N」, 배지 「오류 N·경고 N·정보 N·보고에 없음」, 상세 탭 「본문·연결·쓰이는 곳·검증」, 그룹 이름 「나가는 연결·들어오는 연결·축·구성·쓰는 스킬·진단」, 빈 자리 「없음」·「항목이 없습니다.」·「경고가 없습니다.」·「진단이 없습니다.」·「보고에 없음」·「상시 목록에 넣은 프로필이 없습니다.」. 없앤 글: 시안의 「저장할 때마다 검증합니다」와 이력, 고치기 글, 목록 머리의 설명 문장(빈 문장으로 둠), 설명 없는 상세의 부제. 덜 띄운 글: 쓰이는 곳의 조건은 메타 줄 끝에, 「항상」은 조건이 없을 때만.",
  "한눈에: 「한눈에」(단추)와 「← 프로필 편집으로」, 범례 「항상·조건부」, 줄 「프로필마다 따로 둔 지침·스킬 목록」, 조건부 줄 아래의 조건 글(조건이 곧 값이라 필요), 「이 노드에는 프로필이 없습니다.」, 열 머리 툴팁(전체 이름, 오류 까닭). 줄인 글: 시안의 칸 설명을 없애고 범례 두 낱말만 남겼다.",
  "오류와 로딩: 「스킬을 불러오지 못했습니다.」·「본문을 읽지 못했습니다.」·「프로필을 모으지 못했습니다.」와 「다시 시도」는 실패 안내의 최소 문구다. 로딩은 글 없이 스켈레톤이다(본문 탭만 기존 FrameLoading 문구).",
])}

판정: 위 글은 모두 세 물음(꼭 필요한가, 줄일 수 있는가, 덜 띄울 수 있는가)을 차례로 지났고, 숫자 카드 줄과 머리 요약 줄은 두지 않았다(§0 10번). 목록의 수는 글자 수 하나로 적고 토큰은 「전체」 줄과 소스 상세의 「예상 N 토큰」에만 남는다.
`;
  mkdirSync(shots, { recursive: true });
  writeFileSync(operationsMainFile, text);
}
