// 시안 묶음이 운영 서버 없이, 정적 호스트의 하위 경로(/d/<slug>/)에서
// 실제 컴포넌트를 돌리기 위한 환경. 앱 모듈보다 먼저 import한다.

type MockHandler = (request: { url: URL; method: string; body: unknown }) => unknown;
const handlers = new Map<string, MockHandler>();
const unmocked: string[] = [];

/** "GET /api/folders" 꼴의 키로 응답을 등록한다. 값은 JSON으로 돌려준다. */
export function mockApi(routes: Record<string, MockHandler | unknown>) {
  for (const [key, value] of Object.entries(routes)) {
    handlers.set(key, typeof value === "function" ? value as MockHandler : () => value);
  }
}

/** 응답을 등록하지 않은 채 불린 주소. 시안 작성자가 무엇을 채워야 하는지 본다. */
export function unmockedRequests(): readonly string[] { return unmocked; }
(window as unknown as { __mockupUnmocked: string[] }).__mockupUnmocked = unmocked;

const params = new URLSearchParams(window.location.search);
export const mockupParams = params;

// 테마: ?theme=light|dark. 없으면 OS 설정. 첫 그리기 전에 맞춘다.
const requested = params.get("theme");
export const initialAppearance: "light" | "dark" | "system" =
  requested === "light" || requested === "dark" ? requested : "system";
const dark = initialAppearance === "system"
  ? !window.matchMedia("(prefers-color-scheme: light)").matches
  : initialAppearance === "dark";
document.documentElement.classList.toggle("dark", dark);

// 화소 비교처럼 CSS 유리만 써야 할 때: ?glass=css
if (params.get("glass") === "css") {
  try { window.localStorage.setItem("ls.webglGlass", "0"); } catch { /* 저장소가 막힌 환경 */ }
}

// 운영 서버로 가는 호출은 밖으로 내보내지 않는다. 등록한 응답만 돌려준다.
const isApi = (url: URL) => url.origin === window.location.origin && /^\/(api|cogito)\//.test(url.pathname);
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input), window.location.href);
  if (!isApi(url)) return realFetch(input, init);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const handler = handlers.get(`${method} ${url.pathname}`);
  if (!handler) {
    unmocked.push(`${method} ${url.pathname}`);
    console.warn(`[mockup] 응답이 없는 호출: ${method} ${url.pathname}`);
    return new Response(JSON.stringify({ error: "mockup: no fixture" }), {
      status: 501, headers: { "Content-Type": "application/json" },
    });
  }
  let body: unknown = null;
  if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
  return new Response(JSON.stringify(handler({ url, method, body })), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
};

// 실시간 스트림은 열리기만 하고 아무것도 보내지 않는다.
const RealEventSource = window.EventSource;
class SilentEventSource extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
  readyState = 1; withCredentials = false;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) { super(); unmocked.push(`STREAM ${url}`); }
  close() { this.readyState = 2; }
}
window.EventSource = new Proxy(RealEventSource, {
  construct(target, args: [string | URL, EventSourceInit?]) {
    const url = new URL(String(args[0]), window.location.href);
    return isApi(url) ? new SilentEventSource(url.pathname) : new target(...args);
  },
});

// 앱 코드는 정적 자원을 루트 절대 주소(/system-portrait.png)로 적고,
// 초상과 첨부 그림은 서버 주소(/api/...)로 부른다. 묶음은 하위 경로에서 열리므로
// 앞의 것은 묶음 기준으로 옮기고, 뒤의 것은 등록한 그림으로 바꾼다.
const images: { pattern: RegExp; file: string }[] = [];

/** 서버가 주던 그림 주소를 묶음 안의 파일로 바꾼다. file은 묶음 기준 상대 경로다. */
export function mockImages(routes: { pattern: RegExp; file: string }[]) { images.push(...routes); }

const bundleBase = new URL(".", document.baseURI).pathname;
function relocated(src: string): string {
  if (!src.startsWith("/") || src.startsWith("//") || (bundleBase !== "/" && src.startsWith(bundleBase))) return src;
  const path = src.split("?")[0]!;
  if (/^\/(api|cogito)\//.test(path)) {
    const match = images.find(route => route.pattern.test(path));
    if (match) return bundleBase + match.file;
    if (!unmocked.includes(`IMAGE ${path}`)) unmocked.push(`IMAGE ${path}`);
    return src;
  }
  return bundleBase + src.slice(1);
}
// 요청이 나가기 전에 주소를 바꾼다. React는 setAttribute로, 일부 코드는 src 속성으로 적는다.
for (const prototype of [HTMLImageElement.prototype, HTMLIFrameElement.prototype, HTMLSourceElement.prototype, HTMLVideoElement.prototype]) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "src")!;
  Object.defineProperty(prototype, "src", {
    ...descriptor,
    set(value: string) { descriptor.set!.call(this, relocated(String(value))); },
  });
  const setAttribute = prototype.setAttribute;
  prototype.setAttribute = function (name: string, value: string) {
    setAttribute.call(this, name, name.toLowerCase() === "src" ? relocated(String(value)) : value);
  };
}

// pages의 코멘트 버튼은 묶음 안의 모든 HTML에 붙는다. 시안 본문(이 문서)의 것만 남기고,
// 안쪽에 끼운 문서(캐릭터 등)의 것은 숨긴다. 바깥 틀의 것은 host.ts가 숨긴다.
new MutationObserver(records => {
  for (const record of records) record.addedNodes.forEach(node => {
    const frames = node instanceof HTMLIFrameElement ? [node] : node instanceof Element ? [...node.querySelectorAll("iframe")] : [];
    for (const frame of frames) frame.addEventListener("load", () => {
      try {
        const style = frame.contentDocument?.createElement("style");
        if (!style) return;
        style.textContent = "#pages-review{display:none!important}";
        frame.contentDocument!.head.append(style);
      } catch { /* 다른 출처의 문서는 건드리지 않는다 */ }
    });
  });
}).observe(document.documentElement, { subtree: true, childList: true });

// 로그인 없이 뜨도록 하는 기본 응답. e2e의 경로 가짜와 같은 값이다.
mockApi({
  "GET /api/health": { healthy: true, ready: true, draining: false, build_id: "mockup" },
  "GET /api/auth/config": { authEnabled: false, devModeEnabled: false },
  "GET /api/auth/status": { authenticated: true, user: null },
});
mockImages([{ pattern: /^\/api\/nodes\/[^/]+\/agents\/[^/]+\/portrait$/, file: "system-portrait.png" }]);
