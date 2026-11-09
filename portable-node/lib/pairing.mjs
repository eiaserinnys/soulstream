import { fetchJson } from "./download.mjs";

export class PairingError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PairingError";
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateNodeId(nodeId) {
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    throw new PairingError("노드 이름이 비었습니다.", "INVALID_NODE_ID");
  }
  if (nodeId.length > 64) {
    throw new PairingError("노드 이름은 64자 이하여야 합니다.", "INVALID_NODE_ID");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nodeId)) {
    throw new PairingError(
      "노드 이름에는 영문, 숫자, '.', '_', '-'만 쓸 수 있고 첫 글자는 영문이나 숫자여야 합니다.",
      "INVALID_NODE_ID",
    );
  }
  return nodeId;
}

export function defaultNodeId(hostname) {
  const slug = String(hostname ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug.length > 0 ? slug : "portable-node";
}

export async function startPairing({ upstream, nodeId, companyPc, timeoutMs, fetchJsonImpl = fetchJson }) {
  validateNodeId(nodeId);
  const url = new URL("/api/node-pair/start", upstream).toString();
  const response = await fetchJsonImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, company_pc: Boolean(companyPc) }),
    timeoutMs,
  });
  if (response.status === 429) {
    throw new PairingError("승인 대기 중인 참여 요청이 너무 많습니다. 잠시 뒤 다시 시도하십시오.", "TOO_MANY_PENDING");
  }
  if (!response.ok || !response.body || typeof response.body !== "object") {
    throw new PairingError(`참여 요청이 실패했습니다 (${response.status}).`, "START_FAILED");
  }
  const body = response.body;
  if (!body.device_code || !body.user_code || !body.expires_at) {
    throw new PairingError("참여 응답에 필요한 값이 없습니다.", "START_MALFORMED");
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    expiresAt: body.expires_at,
    intervalSecs: Number(body.interval_secs) > 0 ? Number(body.interval_secs) : 3,
  };
}

/**
 * 승인될 때까지 poll한다. 만료·미승인 대기 한계·404는 PairingError로 끝내고,
 * 자동 재참여나 승인 질문 반복은 하지 않는다.
 */
export async function awaitApproval({
  upstream,
  deviceCode,
  expiresAt,
  intervalSecs = 3,
  timeoutMs,
  sleepImpl = sleep,
  nowImpl = Date.now,
  fetchJsonImpl = fetchJson,
  onPending,
}) {
  const url = new URL("/api/node-pair/poll", upstream).toString();
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) {
    throw new PairingError("참여 만료 시각을 해석하지 못했습니다.", "INVALID_EXPIRY");
  }
  let notified = false;
  while (nowImpl() < deadline) {
    const remaining = deadline - nowImpl();
    await sleepImpl(Math.min(Math.max(intervalSecs, 1) * 1000, Math.max(remaining, 0)));
    if (nowImpl() >= deadline) break;
    const response = await fetchJsonImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
      timeoutMs,
    });
    if (response.status === 404) {
      throw new PairingError(
        "참여 코드가 만료되었거나 이미 사용되었습니다. 다시 실행해 새 코드를 받으십시오.",
        "EXPIRED",
      );
    }
    if (response.status === 200 && response.body?.status === "approved") {
      if (!response.body.token) {
        throw new PairingError("승인 응답에 노드 토큰이 없습니다.", "MALFORMED_APPROVAL");
      }
      return {
        nodeId: response.body.node_id,
        companyPc: Boolean(response.body.company_pc),
        token: response.body.token,
      };
    }
    if (response.status !== 200 || response.body?.status !== "pending") {
      throw new PairingError(`참여 확인이 실패했습니다 (${response.status}).`, "POLL_FAILED");
    }
    if (!notified && onPending) {
      notified = true;
      onPending({ remainingMs: deadline - nowImpl() });
    }
  }
  throw new PairingError(
    "참여 코드의 유효 시간이 지났습니다. 다시 실행해 새 코드를 받으십시오.",
    "EXPIRED",
  );
}
