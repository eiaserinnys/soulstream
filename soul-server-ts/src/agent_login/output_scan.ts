/**
 * CLI 출력 해석. 입력은 CLI 원출력이고, 여기서 뽑은 값(주소, 코드)만 스냅샷으로 나간다.
 * 어떤 함수도 로그를 남기지 않는다.
 */

const CSI_PATTERN = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SIMPLE_ESCAPE_PATTERN = /\x1b[()][0-9A-Za-z]|\x1b[=>]/g;
const OSC8_PATTERN = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const CODEX_URL_PATTERN = /https:\/\/[^\s"'<>]+/;
const CODEX_CODE_PATTERN = /^[A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+$/;
const CODEX_EXPIRES_PATTERN = /expires in (\d+) minutes?/i;
const GOOGLE_AUTH_HOST = "accounts.google.com";

export function stripAnsi(raw: string): string {
  return raw
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(SIMPLE_ESCAPE_PATTERN, "")
    .replace(/\r/g, "");
}

/** 화면 다시 그리기가 공백을 커서 이동으로 바꿔도 안내 문구를 찾도록 공백을 모두 버리고 소문자로 만든다. */
export function compactText(raw: string): string {
  return stripAnsi(raw).replace(/\s+/g, "").toLowerCase();
}

export function appendTail(buffer: string, chunk: string, limit: number): string {
  const next = buffer + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export interface CodexDeviceInfo {
  authUrl: string;
  userCode: string;
  expiresInMinutes: number | null;
}

/** 줄바꿈으로 끝난 줄만 본다. 주소와 코드가 둘 다 읽혀야 값을 돌려준다. */
export function parseCodexDeviceOutput(raw: string): CodexDeviceInfo | null {
  const lines = stripAnsi(raw).split("\n");
  lines.pop();
  const urlIndex = lines.findIndex((line) => CODEX_URL_PATTERN.test(line));
  if (urlIndex < 0) return null;
  const authUrl = CODEX_URL_PATTERN.exec(lines[urlIndex]!)![0].replace(/[),.;]+$/, "");
  const promptIndex = lines.findIndex((line, index) => index > urlIndex && /one-time code/i.test(line));
  if (promptIndex < 0) return null;
  const userCode = lines
    .slice(promptIndex + 1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!userCode || !CODEX_CODE_PATTERN.test(userCode)) return null;
  const minutes = CODEX_EXPIRES_PATTERN.exec(lines[promptIndex]!)?.[1];
  return { authUrl, userCode, expiresInMinutes: minutes === undefined ? null : Number(minutes) };
}

/** 기기 코드 인증이 꺼진 계정에서 Codex가 찍는 안내를 알아본다. */
export function indicatesDeviceCodeDisabled(raw: string): boolean {
  const text = stripAnsi(raw);
  return /device code/i.test(text) && /(disabled|enable)/i.test(text);
}

/** OSC 8 하이퍼링크 안에서 Google 인증 주소를 뽑는다. 줄바꿈으로 접힌 화면 글자는 보지 않는다. */
export function extractGoogleAuthUrl(raw: string): string | null {
  for (const match of raw.matchAll(OSC8_PATTERN)) {
    const candidate = match[1] ?? "";
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && parsed.hostname === GOOGLE_AUTH_HOST) return candidate;
    } catch {
      // 닫는 링크(주소 없음)와 다른 링크는 건너뛴다.
    }
  }
  return null;
}

export const AGY_SELECT_MARKER = "selectloginmethod";
export const AGY_PASTE_MARKER = "pastetheauthorizationcode";
const AGY_INVALID_MARKERS = [
  "invalidauthorizationcode",
  "failedtoexchangeauthorizationcodefortoken",
];
const AGY_SUCCESS_MARKERS = [
  "successfullyauthenticated",
  "oauth:authenticatedsuccessfullyas",
  "loggedin.",
  "authenticatedas",
  "alreadyauthenticatedas",
];

export function indicatesAgyInvalidCode(compact: string): boolean {
  return AGY_INVALID_MARKERS.some((marker) => compact.includes(marker));
}

export function indicatesAgySuccess(compact: string): boolean {
  return AGY_SUCCESS_MARKERS.some((marker) => compact.includes(marker));
}
