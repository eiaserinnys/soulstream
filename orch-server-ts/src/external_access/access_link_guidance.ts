import type {
  ExternalAccessGrant,
  ExternalAccessPermission,
} from "./external_access_grant_repository.js";

/**
 * The guidance the external CLI agent reads from `GET /x/<key>` (design 3.2).
 *
 * Only the actions this link is allowed to perform appear. The text is the
 * default; an `Accept: application/json` request gets the same facts as JSON.
 */

export interface ExternalAccessTarget {
  /** `sessions.display_name`, else `agent_id`; nothing else leaves the row. */
  readonly display_name: string | null;
}

interface GuidanceAction {
  readonly name: ExternalAccessPermission;
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly curl: string;
}

interface GuidanceStatusValue {
  readonly value: string;
  readonly meaning: string;
}

interface GuidanceError {
  readonly status: number;
  readonly meaning: string;
}

export interface ExternalAccessGuidance {
  readonly target: { readonly display_name: string; readonly expires_at: string | null };
  readonly permissions: readonly ExternalAccessPermission[];
  readonly actions: readonly GuidanceAction[];
  readonly status: {
    readonly values: readonly GuidanceStatusValue[];
    readonly terminal: readonly string[];
    readonly outcome: readonly GuidanceStatusValue[];
    readonly stopped_session: string;
  };
  readonly errors: readonly GuidanceError[];
  readonly notes: readonly string[];
}

const PERMISSION_ORDER: readonly ExternalAccessPermission[] = [
  "send",
  "read_own",
  "read_history",
  "control",
];

const STATUS_VALUES: readonly GuidanceStatusValue[] = [
  { value: "accepted", meaning: "접수되었습니다. 소울스트림이 전달 책임을 졌습니다." },
  { value: "processing", meaning: "대상 세션의 실행에 전달되었습니다." },
  { value: "completed", meaning: "대상 에이전트가 이 요청을 마감했습니다." },
  { value: "failed", meaning: "전달이 실패했습니다." },
];

const STATUS_OUTCOME: readonly GuidanceStatusValue[] = [
  { value: "replied", meaning: "마감에 글이 있었습니다." },
  { value: "no_reply", meaning: "대상이 답할 것이 없어 글 없이 마감했습니다." },
];

const ERRORS: readonly GuidanceError[] = [
  { status: 401, meaning: "유효하지 않은 링크입니다(만료, 폐기, 틀린 키). 사유는 구분하지 않습니다." },
  { status: 403, meaning: "이 링크에 허용되지 않은 동작입니다." },
  { status: 404, meaning: "없는 요청이거나 없는 경로입니다." },
  { status: 409, meaning: "같은 request_id 에 다른 본문을 보냈거나, 실행 중이 아닌 세션을 멈추려 했습니다." },
  { status: 413, meaning: "본문이 256KiB 를 넘습니다." },
  { status: 415, meaning: "Content-Type 이 application/json 이 아닙니다." },
  { status: 429, meaning: "요청이 너무 잦습니다. Retry-After 초 뒤에 다시 시도하십시오." },
];

const REPLY_POLLING_NOTE =
  "회신은 messages/<request_id>?wait=25 를 끝나는 상태(completed, failed)가 될 때까지 다시 불러 replies 에서 받습니다.";

const NOTES: readonly string[] = [
  "request_id 를 직접 정해 보내면 재시도해도 중복 접수되지 않습니다. 지정하지 않으면 응답의 request_id 를 기억하십시오.",
  "대상이 되물으면 회신(replies)으로 묻습니다. 다음 메시지로 답하십시오. 구조화 질문에 직접 답하는 경로는 없습니다.",
  "한 링크는 한 발신자입니다. 같은 링크를 여럿이 쓰면 구분되지 않으니 발신자마다 링크를 따로 발급하십시오.",
  "만료나 폐기 뒤에도 이미 접수된 메시지는 처리됩니다. 접수된 메시지를 취소하는 방법은 없습니다.",
  "세션의 폴더, 카드, 노드 정보는 이 링크로 알 수 없습니다.",
];

/** Builds the guidance body. Callers choose `application/json` from Accept. */
export function buildAccessLinkGuidance(
  grant: ExternalAccessGrant,
  target: ExternalAccessTarget,
  linkUrl: string,
  wantsJson: boolean,
): { contentType: string; body: string } {
  const model = guidanceModel(grant, target, linkUrl);
  if (!wantsJson) {
    return { contentType: "text/plain; charset=utf-8", body: guidanceMarkdown(model) };
  }
  return {
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({
      target: model.target,
      permissions: model.permissions,
      actions: model.actions,
      status: model.status,
      errors: model.errors,
      notes: model.notes,
    }),
  };
}

function guidanceModel(
  grant: ExternalAccessGrant,
  target: ExternalAccessTarget,
  linkUrl: string,
): ExternalAccessGuidance {
  const permissions = PERMISSION_ORDER.filter((permission) =>
    grant.permissions.includes(permission)
  );
  const displayName = target.display_name?.trim()
    || "대상 세션";
  const notes = permissions.includes("read_own")
    ? [REPLY_POLLING_NOTE, ...NOTES]
    : NOTES;
  return {
    target: {
      display_name: displayName,
      expires_at: grant.expires_at?.toISOString() ?? null,
    },
    permissions,
    actions: permissions.map((permission) => guidanceAction(permission, linkUrl)),
    status: {
      values: STATUS_VALUES,
      terminal: ["completed", "failed"],
      outcome: STATUS_OUTCOME,
      stopped_session:
        "processing 인데 session.state 가 idle, error, stopped 이면 대상이 멈춘 것이고 "
        + "이 요청의 결과는 확인되지 않은 것입니다. 기다림을 멈추거나 다음 메시지로 되물으십시오.",
    },
    errors: ERRORS,
    notes,
  };
}

function guidanceAction(
  permission: ExternalAccessPermission,
  linkUrl: string,
): GuidanceAction {
  switch (permission) {
    case "send":
      return {
        name: permission,
        method: "POST",
        url: `${linkUrl}/messages`,
        curl: `curl -sS -X POST '${linkUrl}/messages' `
          + "-H 'Content-Type: application/json' "
          + "-d '{\"text\":\"...\",\"request_id\":\"my-request-1\"}'",
      };
    case "read_own":
      return {
        name: permission,
        method: "GET",
        url: `${linkUrl}/messages/<request_id>?wait=25`,
        curl: `curl -sS '${linkUrl}/messages/<request_id>?wait=25'`,
      };
    case "read_history":
      return {
        name: permission,
        method: "GET",
        url: `${linkUrl}/history?limit=50`,
        curl: `curl -sS '${linkUrl}/history?limit=50'`,
      };
    case "control":
      return {
        name: permission,
        method: "POST",
        url: `${linkUrl}/stop`,
        curl: `curl -sS -X POST '${linkUrl}/stop' `
          + "-H 'Content-Type: application/json'",
      };
  }
}

function guidanceMarkdown(model: ExternalAccessGuidance): string {
  const lines: string[] = [
    "# 외부 접속 링크",
    "",
    `대상: ${model.target.display_name}`,
    `만료: ${model.target.expires_at ?? "없음"}`,
    `허용된 동작: ${model.permissions.length === 0 ? "없음" : model.permissions.join(", ")}`,
    "",
  ];
  for (const action of model.actions) {
    lines.push(
      `## ${action.name}`,
      "",
      `${action.method} ${action.url}`,
      "",
      "```",
      action.curl,
      "```",
      "",
    );
  }
  lines.push(
    "## 상태 값",
    "",
    ...model.status.values.map((entry) => `- ${entry.value}: ${entry.meaning}`),
    `- 끝나는 상태: ${model.status.terminal.join(", ")}`,
    ...model.status.outcome.map((entry) => `- outcome ${entry.value}: ${entry.meaning}`),
    `- ${model.status.stopped_session}`,
    "",
    "## 오류",
    "",
    ...model.errors.map((entry) => `- ${entry.status}: ${entry.meaning}`),
    "",
    "## 참고",
    "",
    ...model.notes.map((note) => `- ${note}`),
    "",
  );
  return lines.join("\n");
}
