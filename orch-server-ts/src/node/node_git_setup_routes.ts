import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { isRecord } from "@soulstream/wire-schema/json-record";
import { requireAdmin, type AdminAccessProvider } from "../admin/admin_access.js";
import type { NodeCommandResponse, RequestResponseNodeCommandPayload } from "./pending_commands.js";
import type { InMemoryNodeRegistry } from "./registry.js";
import { supportsNodeGitSetup } from "./registry_helpers.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";

export type NodeGitSetupRouteOptions = {
  readonly registry: InMemoryNodeRegistry;
  readonly bridge: SessionCommandTransportBridge;
  readonly timeoutMs?: number;
  /** 노드의 Git 설정은 관리자만 만진다. 관리자 전용 설정 경로가 쓰는 판정(requireAdmin)과 같다. */
  readonly adminAccess: AdminAccessProvider;
};

export const nodeGitSetupRouteAuthRequirements = {
  "GET /api/nodes/:node_id/git": true,
  "PUT /api/nodes/:node_id/git/identity": true,
  "POST /api/nodes/:node_id/git/ssh-key": true,
  "POST /api/nodes/:node_id/git/ssh-check": true,
  "POST /api/nodes/:node_id/git/clones": true,
  "GET /api/nodes/:node_id/git/clones/:clone_id": true,
} as const;

type NodeParams = { node_id: string };
type CloneParams = NodeParams & { clone_id: string };
type GitCommandResult = NodeCommandResponse & { success?: unknown; data?: unknown; error?: unknown };
type BodyField = "name" | "email" | "host" | "url" | "repo_name";
type BodyResult =
  | { readonly ok: true; readonly fields: Record<string, string> }
  | { readonly ok: false; readonly field?: BodyField };

const FIELD_MAX_LENGTH: Readonly<Record<BodyField, number>> = {
  name: 200,
  email: 320,
  host: 253,
  url: 2_048,
  repo_name: 100,
};
const BODY_FIELDS = new Set<string>(Object.keys(FIELD_MAX_LENGTH));
const CLONE_ID = /^[A-Za-z0-9-]{1,64}$/;
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  "ssh_key_exists",
  "repo_exists",
  "clone_busy",
  "projects_root_unavailable",
  "git_not_installed",
  "ssh_not_installed",
]);

export function registerNodeGitSetupRoutes(app: FastifyInstance, options: NodeGitSetupRouteOptions): void {
  app.get<{ Params: NodeParams }>("/api/nodes/:node_id/git", (request, reply) =>
    adminRoute(request, reply, options, () =>
      sendGitCommand(request, reply, options, { type: "node_git_status" }, 200)));

  app.put<{ Params: NodeParams; Body: unknown }>("/api/nodes/:node_id/git/identity", (request, reply) =>
    adminRoute(request, reply, options, () =>
      withBody(request, reply, options, ["name", "email"], [], (fields) =>
        ({ type: "node_git_identity_set", name: fields.name, email: fields.email }), 200)));

  app.post<{ Params: NodeParams }>("/api/nodes/:node_id/git/ssh-key", (request, reply) =>
    adminRoute(request, reply, options, () =>
      sendGitCommand(request, reply, options, { type: "node_git_ssh_key_create" }, 201)));

  app.post<{ Params: NodeParams; Body: unknown }>("/api/nodes/:node_id/git/ssh-check", (request, reply) =>
    adminRoute(request, reply, options, () =>
      withBody(request, reply, options, ["host"], [], (fields) =>
        ({ type: "node_git_ssh_check", host: fields.host }), 200)));

  app.post<{ Params: NodeParams; Body: unknown }>("/api/nodes/:node_id/git/clones", (request, reply) =>
    adminRoute(request, reply, options, () =>
      withBody(request, reply, options, ["url"], ["repo_name"], (fields) =>
        ({
          type: "node_git_clone_start",
          url: fields.url,
          ...(fields.repo_name === undefined ? {} : { repo_name: fields.repo_name }),
        }), 202)));

  app.get<{ Params: CloneParams }>("/api/nodes/:node_id/git/clones/:clone_id", (request, reply) =>
    adminRoute(request, reply, options, async (): Promise<FastifyReply> => {
      if (!CLONE_ID.test(request.params.clone_id)) {
        return sendGitError(reply, 422, "invalid_request", "올바르지 않은 클론 작업 번호입니다.");
      }
      return await sendGitCommand(request, reply, options,
        { type: "node_git_clone_status", clone_id: request.params.clone_id }, 200);
    }));
}

/** 관리자가 아니면 본문 검사나 노드 조회 결과를 알려주지 않고 여기서 끝낸다. */
async function adminRoute(
  request: FastifyRequest,
  reply: FastifyReply,
  options: NodeGitSetupRouteOptions,
  run: () => Promise<FastifyReply>,
): Promise<FastifyReply> {
  if (await requireAdmin(request, reply, options.adminAccess) === undefined) return reply;
  return await run();
}

async function withBody(
  request: FastifyRequest<{ Params: NodeParams; Body: unknown }>,
  reply: FastifyReply,
  options: NodeGitSetupRouteOptions,
  required: readonly BodyField[],
  optional: readonly BodyField[],
  toPayload: (fields: Record<string, string | undefined>) => RequestResponseNodeCommandPayload,
  successStatus: number,
): Promise<FastifyReply> {
  const body = parseBody(request.body, required, optional);
  if (!body.ok) {
    return sendGitError(reply, 422, "invalid_request", "올바르지 않은 요청 본문입니다.", body.field);
  }
  return await sendGitCommand(request, reply, options, toPayload(body.fields), successStatus);
}

async function sendGitCommand(
  request: FastifyRequest<{ Params: NodeParams }>,
  reply: FastifyReply,
  options: NodeGitSetupRouteOptions,
  payload: RequestResponseNodeCommandPayload,
  successStatus: number,
): Promise<FastifyReply> {
  const nodeId = request.params.node_id;
  const node = options.registry.getConnectedNode(nodeId);
  if (node === undefined) return sendGitError(reply, 404, "node_not_connected", "노드가 연결되어 있지 않습니다.");
  if (!supportsNodeGitSetup(node.capabilities)) {
    return sendGitError(reply, 409, "node_git_unsupported", "이 노드는 Git 설정을 지원하지 않습니다.");
  }

  let response: GitCommandResult;
  try {
    const command = options.registry.createCommand(nodeId, payload, { timeoutMs: options.timeoutMs });
    response = await options.bridge.sendPendingCommand({ node, command }) as GitCommandResult;
  } catch (error) {
    const code = error instanceof Error && error.name === "PendingNodeCommandTimeoutError"
      ? "node_command_timeout"
      : "node_command_failed";
    return sendGitError(reply, 502, code, "노드에 Git 요청을 보내지 못했습니다.");
  }
  if (response.success !== true) return sendNodeRejection(reply, response);
  return reply.code(successStatus).send(response.data);
}

function parseBody(
  value: unknown,
  required: readonly BodyField[],
  optional: readonly BodyField[],
): BodyResult {
  if (!isRecord(value)) return { ok: false };
  const allowed = new Set<string>([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key) || !BODY_FIELDS.has(key))) return { ok: false };
  const fields: Record<string, string> = {};
  for (const field of [...required, ...optional]) {
    const item = value[field];
    if (item === undefined && optional.includes(field)) continue;
    if (typeof item !== "string" || item.length === 0 || item.length > FIELD_MAX_LENGTH[field]) {
      return { ok: false, field };
    }
    fields[field] = item;
  }
  return { ok: true, fields };
}

function sendNodeRejection(reply: FastifyReply, response: GitCommandResult): FastifyReply {
  const workerError = isRecord(response.error) ? response.error : null;
  const code = safeErrorCode(workerError?.code);
  const field = typeof workerError?.field === "string" && BODY_FIELDS.has(workerError.field)
    ? workerError.field as BodyField
    : undefined;
  return sendGitError(reply, rejectionStatus(code), code, errorMessage(code), code === "invalid_request" ? field : undefined);
}

function rejectionStatus(code: string): 404 | 409 | 422 | 502 {
  if (code === "invalid_request") return 422;
  if (code === "clone_not_found") return 404;
  return CONFLICT_CODES.has(code) ? 409 : 502;
}

function sendGitError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  field?: BodyField,
): FastifyReply {
  return reply.code(status).send({ code, message, ...(field === undefined ? {} : { field }) });
}

function errorMessage(code: string): string {
  switch (code) {
    case "invalid_request": return "올바르지 않은 Git 요청입니다.";
    case "clone_not_found": return "클론 작업을 찾을 수 없습니다.";
    case "ssh_key_exists": return "이 노드에는 이미 SSH 키가 있습니다.";
    case "repo_exists": return "같은 이름의 폴더가 이미 있습니다.";
    case "clone_busy": return "다른 클론이 아직 진행 중입니다.";
    case "projects_root_unavailable": return "이 노드의 저장소 폴더를 사용할 수 없습니다.";
    case "git_not_installed": return "이 노드에 git이 설치되어 있지 않습니다.";
    case "ssh_not_installed": return "이 노드에 ssh가 설치되어 있지 않습니다.";
    default: return "Git 요청이 거절되었습니다.";
  }
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value)
    ? value.toLowerCase()
    : "node_command_rejected";
}
