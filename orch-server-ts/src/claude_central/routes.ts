import type { FastifyInstance, FastifyReply } from "fastify";

import { isRecord } from "@soulstream/wire-schema/json-record";
import { ClaudeCentralLoginError, type ClaudeCentralLoginSnapshot } from "./login_service.js";
import { ClaudeCentralNotFoundError } from "./service.js";
import type {
  ClaudeCentralAccountList,
  ClaudeCentralSettingsView,
} from "./types.js";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ClaudeCentralRouteService = {
  getAccountList(): Promise<ClaudeCentralAccountList>;
  patchAccount(
    accountId: string,
    patch: { readonly enabled?: boolean; readonly priority?: number },
  ): Promise<ClaudeCentralAccountList>;
  deleteAccount(accountId: string): Promise<boolean>;
  getSettings(): Promise<ClaudeCentralSettingsView>;
  updateSettings(input: {
    readonly default_receive?: boolean;
    readonly nodes?: Readonly<Record<string, boolean | null>>;
  }): Promise<ClaudeCentralSettingsView>;
  startLogin(input: { account_id?: string }): Promise<ClaudeCentralLoginSnapshot>;
  submitLoginCode(loginId: string, code: string): Promise<ClaudeCentralLoginSnapshot>;
  getLogin(loginId: string): ClaudeCentralLoginSnapshot;
  cancelLogin(loginId: string): ClaudeCentralLoginSnapshot;
};

export type ClaudeCentralRouteOptions = {
  readonly service: ClaudeCentralRouteService;
};

type AccountParams = { id: string };
type LoginParams = { login_id: string };

export function registerClaudeCentralRoutes(
  app: FastifyInstance,
  options: ClaudeCentralRouteOptions,
): void {
  app.get(
    "/api/claude-auth/central/accounts",
    async (_request, reply) => {
      try {
        return reply.send(await options.service.getAccountList());
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.patch<{ Params: AccountParams; Body: unknown }>(
    "/api/claude-auth/central/accounts/:id",
    async (request, reply) => {
      if (!isAccountId(request.params.id)) return invalidRequestReply(reply, "올바르지 않은 Claude 계정 ID입니다.");
      const patch = parseAccountPatch(request.body);
      if (patch === null) return invalidRequestReply(reply, "올바르지 않은 Claude 계정 수정 요청입니다.");
      try {
        return reply.send(await options.service.patchAccount(request.params.id, patch));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.delete<{ Params: AccountParams }>(
    "/api/claude-auth/central/accounts/:id",
    async (request, reply) => {
      if (!isAccountId(request.params.id)) return invalidRequestReply(reply, "올바르지 않은 Claude 계정 ID입니다.");
      try {
        const deleted = await options.service.deleteAccount(request.params.id);
        if (!deleted) throw new ClaudeCentralNotFoundError();
        return reply.send({ success: true });
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{ Body: unknown }>(
    "/api/claude-auth/central/logins",
    async (request, reply) => {
      const accountId = parseLoginStartBody(request.body);
      if (accountId === undefined) return invalidRequestReply(reply, "올바르지 않은 Claude 로그인 요청입니다.");
      try {
        return reply.code(202).send(await options.service.startLogin(
          accountId === null ? {} : { account_id: accountId },
        ));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.get<{ Params: LoginParams }>(
    "/api/claude-auth/central/logins/:login_id",
    async (request, reply) => {
      try {
        return reply.send(options.service.getLogin(request.params.login_id));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.post<{ Params: LoginParams; Body: unknown }>(
    "/api/claude-auth/central/logins/:login_id/code",
    async (request, reply) => {
      const code = parseLoginCode(request.body);
      if (code === null) return invalidRequestReply(reply, "올바르지 않은 Claude 인증 코드입니다.");
      try {
        return reply.send(await options.service.submitLoginCode(request.params.login_id, code));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.delete<{ Params: LoginParams }>(
    "/api/claude-auth/central/logins/:login_id",
    async (request, reply) => {
      try {
        return reply.send(options.service.cancelLogin(request.params.login_id));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.get(
    "/api/claude-auth/central/settings",
    async (_request, reply) => {
      try {
        return reply.send(await options.service.getSettings());
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );

  app.put<{ Body: unknown }>(
    "/api/claude-auth/central/settings",
    async (request, reply) => {
      const input = parseSettingsUpdate(request.body);
      if (input === null) return invalidRequestReply(reply, "올바르지 않은 중앙 풀 설정 요청입니다.");
      try {
        return reply.send(await options.service.updateSettings(input));
      } catch (error) {
        return sendServiceError(reply, error);
      }
    },
  );
}

function sendServiceError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ClaudeCentralLoginError || error instanceof ClaudeCentralNotFoundError) {
    return reply.code(error.statusCode).send({ code: error.code, message: error.message });
  }
  return reply.code(500).send({
    code: "claude_central_error",
    message: "Claude 중앙 계정 요청을 처리하지 못했습니다.",
  });
}

function invalidRequestReply(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: "invalid_request", message });
}

function parseAccountPatch(value: unknown): { enabled?: boolean; priority?: number } | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== "enabled" && key !== "priority")) return null;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return null;
  let priority: number | undefined;
  if (value.priority !== undefined) {
    if (value.priority === null) priority = 0;
    else if (typeof value.priority === "number" && Number.isFinite(value.priority)) priority = value.priority;
    else return null;
  }
  return {
    ...(value.enabled === undefined ? {} : { enabled: value.enabled }),
    ...(priority === undefined ? {} : { priority }),
  };
}

function parseLoginStartBody(value: unknown): string | null | undefined {
  const body = value === undefined ? {} : value;
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "account_id")) return undefined;
  if (body.account_id === undefined) return null;
  return isAccountId(body.account_id) ? body.account_id : undefined;
}

function parseLoginCode(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "code")) return null;
  const code = value.code;
  return typeof code === "string" && code.trim().length > 0 && !/[\r\n]/.test(code) ? code : null;
}

function parseSettingsUpdate(
  value: unknown,
): { default_receive?: boolean; nodes?: Record<string, boolean | null> } | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== "default_receive" && key !== "nodes")) return null;
  if (value.default_receive !== undefined && typeof value.default_receive !== "boolean") return null;
  let nodes: Record<string, boolean | null> | undefined;
  if (value.nodes !== undefined) {
    if (!isRecord(value.nodes)) return null;
    nodes = {};
    for (const [nodeId, receive] of Object.entries(value.nodes)) {
      if (nodeId.length === 0) return null;
      if (receive !== true && receive !== false && receive !== null) return null;
      nodes[nodeId] = receive;
    }
  }
  return {
    ...(value.default_receive === undefined ? {} : { default_receive: value.default_receive }),
    ...(nodes === undefined ? {} : { nodes }),
  };
}

function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID.test(value);
}
