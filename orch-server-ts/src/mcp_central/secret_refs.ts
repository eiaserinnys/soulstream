import { createHash } from "node:crypto";

import { isRecord } from "@soulstream/wire-schema/json-record";

import { McpCentralError, invalidInput } from "./errors.js";
import type { McpServerDefinition } from "./types.js";

/**
 * `{{secret:name}}` / `{{env:NAME}}` 참조 문법. 이름 규칙은 mcp_secrets의
 * 이름 규칙과 같다.
 */
export const SECRET_REF_PATTERN = /\{\{(secret|env):([A-Za-z0-9][A-Za-z0-9._-]{0,63})\}\}/g;
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type RefScan = { readonly secret: boolean; readonly env: boolean };

type SecretSink = Map<string, string>;

type UnitNaming = {
  readonly header: (key: string) => string;
  readonly query: (key: string, suffix: string) => string;
  readonly env: (key: string) => string;
};

export function scanSecretRefs(value: string): RefScan {
  let secret = false;
  let env = false;
  for (const match of value.matchAll(SECRET_REF_PATTERN)) {
    if (match[1] === "secret") secret = true;
    else env = true;
  }
  return { secret, env };
}

export function assertNotMixed(value: string): void {
  const refs = scanSecretRefs(value);
  if (refs.secret && refs.env) {
    throw new McpCentralError(
      "MCP_MIXED_SECRET_ENV_REF",
      400,
      "A value must not mix {{secret:...}} and {{env:...}} references",
    );
  }
}

export function assertSecretName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw invalidInput(`secret name is invalid: ${name}`);
  }
}

/**
 * 위치로 정해지는 결정적 이름. 같은 서버의 같은 자리를 다시 저장하면 같은
 * 이름이 나온다. 64자를 넘으면 잘라 짧은 해시를 붙인다.
 */
export function deterministicSecretName(raw: string): string {
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, "-");
  if (SECRET_NAME_PATTERN.test(sanitized)) return sanitized;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const head = sanitized.slice(0, 55).replace(/[^A-Za-z0-9]+$/, "");
  return `${head}-${digest}`;
}

/** 서버 하나(또는 그 노드 덮어쓰기)의 자리 이름 규칙. */
function definitionNaming(serverId: string, nodeId?: string): UnitNaming {
  const base = nodeId === undefined ? `srv-${serverId}` : `srv-${serverId}-ovr-${nodeId}`;
  return {
    header: (key) => deterministicSecretName(`${base}-hdr-${key}`),
    query: (key, suffix) => deterministicSecretName(`${base}-qry-${key}${suffix}`),
    env: (key) => deterministicSecretName(`${base}-env-${key}`),
  };
}

/**
 * 한 비교 단위(헤더 값, env 값, 쿼리 값)를 처리한다. 이미 참조가 있으면 두고,
 * 고정값이면 비밀로 옮기고 그 자리를 참조로 바꾼다.
 */
function processUnit(value: string, name: string, secrets: SecretSink): string {
  const refs = scanSecretRefs(value);
  if (refs.secret && refs.env) assertNotMixed(value);
  if (refs.secret || refs.env) return value;
  secrets.set(name, value);
  return `{{secret:${name}}}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * URL의 쿼리 값 하나하나를 처리한다. 참조로 바뀐 값은 URL에 넣을 때
 * encodeURIComponent 규칙을 따른다. 쿼리 앞부분은 옮기지 않고 혼용만 막는다.
 */
function processUrl(url: string, naming: UnitNaming, secrets: SecretSink, reserved: Set<string>): string {
  const queryStart = url.indexOf("?");
  if (queryStart < 0) {
    assertNotMixed(url);
    return url;
  }
  const base = url.slice(0, queryStart);
  assertNotMixed(base);
  const query = url.slice(queryStart + 1);
  const parts = query.split("&");
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals >= 0) collectSecretReferences(safeDecode(part.slice(equals + 1)), reserved);
  }
  const rewritten = parts.map((part) => {
    const equals = part.indexOf("=");
    if (equals < 0) return part;
    const key = part.slice(0, equals);
    const rawValue = part.slice(equals + 1);
    const decoded = safeDecode(rawValue);
    const refs = scanSecretRefs(decoded);
    if (refs.secret || refs.env) {
      assertNotMixed(decoded);
      return part;
    }
    const keyName = safeDecode(key.replace(/\+/g, " "));
    let number = 1;
    let name = naming.query(keyName, "");
    while (reserved.has(name)) name = naming.query(keyName, `-${++number}`);
    reserved.add(name);
    const replaced = processUnit(decoded, name, secrets);
    return replaced === decoded ? part : `${key}=${encodeURIComponent(replaced)}`;
  });
  return `${base}?${rewritten.join("&")}`;
}

function processStringRecord(
  record: Readonly<Record<string, unknown>>,
  nameFor: (key: string) => string,
  secrets: SecretSink,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = typeof value === "string" ? processUnit(value, nameFor(key), secrets) : value;
  }
  return result;
}

function processConfig(
  config: Readonly<Record<string, unknown>>,
  naming: UnitNaming,
  secrets: SecretSink,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  if (isRecord(next.headers)) {
    next.headers = processStringRecord(next.headers, naming.header, secrets);
  }
  if (isRecord(next.env)) {
    next.env = processStringRecord(next.env, naming.env, secrets);
  }
  if (typeof next.url === "string") {
    next.url = processUrl(next.url, naming, secrets, collectSecretReferences(config));
  }
  return next;
}

function processDefinition(
  definition: McpServerDefinition,
  naming: UnitNaming,
  secrets: SecretSink,
): McpServerDefinition {
  return {
    ...definition,
    config: processConfig(definition.config, naming, secrets),
  };
}

export type ServerSecretExtraction = {
  readonly definition: McpServerDefinition;
  readonly node_overrides: Record<string, McpServerDefinition>;
  readonly secrets: SecretSink;
};

/**
 * 서버 정의와 노드 덮어쓰기에서 고정값을 mcp_secrets로 옮긴다. 반환된 정의는
 * 옮긴 자리가 `{{secret:...}}` 참조로 바뀐 저장용 정의다.
 */
export function extractServerSecrets(
  serverId: string,
  definition: McpServerDefinition,
  nodeOverrides: Readonly<Record<string, McpServerDefinition>>,
): ServerSecretExtraction {
  const secrets: SecretSink = new Map();
  const nextDefinition = processDefinition(definition, definitionNaming(serverId), secrets);
  const nextOverrides: Record<string, McpServerDefinition> = {};
  for (const [nodeId, override] of Object.entries(nodeOverrides)) {
    nextOverrides[nodeId] = processDefinition(
      override,
      definitionNaming(serverId, nodeId),
      secrets,
    );
  }
  return { definition: nextDefinition, node_overrides: nextOverrides, secrets };
}

export type HostedToolSecretExtraction = {
  readonly hosted_tools: unknown[];
  readonly secrets: SecretSink;
};

/**
 * 프로필 hosted_tools의 hosted_mcp 값에서 authorization, headers 값,
 * server_url 쿼리 값을 같은 규칙으로 처리한다.
 */
export function extractHostedToolSecrets(
  profileId: string,
  hostedTools: readonly unknown[],
): HostedToolSecretExtraction {
  const secrets: SecretSink = new Map();
  const tools = hostedTools.map((tool, index) => {
    if (!isRecord(tool) || tool.type !== "hosted_mcp") return tool;
    const base = `prof-${profileId}-ht${index}`;
    const next: Record<string, unknown> = { ...tool };
    if (typeof next.authorization === "string") {
      next.authorization = processUnit(
        next.authorization,
        deterministicSecretName(`${base}-auth`),
        secrets,
      );
    }
    if (isRecord(next.headers)) {
      next.headers = processStringRecord(
        next.headers,
        (key) => deterministicSecretName(`${base}-hdr-${key}`),
        secrets,
      );
    }
    if (typeof next.server_url === "string") {
      next.server_url = processUrl(
        next.server_url,
        {
          header: (key) => deterministicSecretName(`${base}-hdr-${key}`),
          query: (key, suffix) => deterministicSecretName(`${base}-qry-${key}${suffix}`),
          env: (key) => deterministicSecretName(`${base}-env-${key}`),
        },
        secrets,
        collectSecretReferences(tool),
      );
    }
    return next;
  });
  return { hosted_tools: tools, secrets };
}

/** 값 안의 모든 비밀 참조 이름을 모은다. 참조 확인(삭제 거절, 롤백 검사)용. */
export function collectSecretReferences(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const match of value.matchAll(SECRET_REF_PATTERN)) {
      if (match[1] === "secret" && match[2] !== undefined) into.add(match[2]);
    }
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSecretReferences(item, into);
    return into;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectSecretReferences(item, into);
  }
  return into;
}
