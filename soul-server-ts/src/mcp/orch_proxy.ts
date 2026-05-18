/**
 * orch HTTP base URL 변환 헬퍼.
 *
 * SOULSTREAM_UPSTREAM_URL은 `ws[s]://host/ws/...` 형식 (reverse WS 등록 경로). multi-node
 * 도구는 HTTP API(`/api/nodes`, `/api/sessions` 등)를 호출하므로 scheme 변환 + ws 경로 제거.
 *
 * ws:// → http://, wss:// → https://. 호스트:포트는 그대로 보존.
 */

export function wsToHttpBase(wsUrl: string): string {
  let scheme: string;
  if (wsUrl.startsWith("wss://")) scheme = "https://";
  else if (wsUrl.startsWith("ws://")) scheme = "http://";
  else {
    throw new Error(
      `wsToHttpBase: expected ws:// or wss:// scheme, got ${wsUrl}`,
    );
  }
  // ws:// 또는 wss:// 제거 후 첫 / 이전까지가 host:port
  const rest = wsUrl.replace(/^wss?:\/\//, "");
  const slashIdx = rest.indexOf("/");
  const hostPort = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  return `${scheme}${hostPort}`;
}
