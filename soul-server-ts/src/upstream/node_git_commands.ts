import type {
  NodeGitCloneStart,
  NodeGitCloneStatus,
  NodeGitIdentitySet,
  NodeGitSshCheck,
  NodeGitSshKeyCreate,
  NodeGitStatus,
} from "@soulstream/wire-schema";

import { NodeGitServiceError } from "../node_git/node_git_validation.js";
import type { NodeGitService } from "../node_git/node_git_service.js";

type NodeGitCommandMessage =
  | NodeGitStatus
  | NodeGitIdentitySet
  | NodeGitSshKeyCreate
  | NodeGitSshCheck
  | NodeGitCloneStart
  | NodeGitCloneStatus;

export type NodeGitCommand = NodeGitCommandMessage & { request_id?: string };
export type NodeGitCommandResponse = NodeGitCommandMessage;
export type NodeGitCommandHandler = Pick<
  NodeGitService,
  "status" | "setIdentity" | "createSshKey" | "checkSsh" | "startClone" | "cloneStatus"
>;

export class NodeGitCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeGitCommandError";
  }
}

/**
 * 노드 Git 설정 명령. 서비스 안의 거절은 응답의 error(code, message, field?)로 돌려주고,
 * 서비스가 없을 때만 디스패처 오류로 올린다. 응답 모양은 agent_login_* 명령과 같다.
 */
export class NodeGitCommands {
  constructor(private readonly deps: { nodeGitService?: NodeGitCommandHandler }) {}

  async handle(cmd: NodeGitCommand): Promise<NodeGitCommandResponse> {
    const service = this.deps.nodeGitService;
    if (!service) {
      throw new NodeGitCommandError("Node git service is not configured in soul-server-ts");
    }
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    try {
      return success(cmd.type, requestId, await this.run(service, cmd));
    } catch (error) {
      return {
        type: cmd.type,
        requestId,
        success: false,
        error: error instanceof NodeGitServiceError
          ? error.toWire()
          : { code: "node_git_failed", message: "Node git command failed" },
      } as NodeGitCommandResponse;
    }
  }

  private run(service: NodeGitCommandHandler, cmd: NodeGitCommand): Promise<unknown> | unknown {
    switch (cmd.type) {
      case "node_git_status": return service.status();
      case "node_git_identity_set": return service.setIdentity({ name: cmd.name, email: cmd.email });
      case "node_git_ssh_key_create": return service.createSshKey();
      case "node_git_ssh_check": return service.checkSsh({ host: cmd.host });
      case "node_git_clone_start": return service.startClone({ url: cmd.url, repo_name: cmd.repo_name });
      case "node_git_clone_status": return service.cloneStatus({ clone_id: cmd.clone_id });
    }
  }
}

function success(type: NodeGitCommand["type"], requestId: string, data: unknown): NodeGitCommandResponse {
  return { type, requestId, success: true, data } as NodeGitCommandResponse;
}
