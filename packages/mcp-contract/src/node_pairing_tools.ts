import { z } from "zod";

import type { McpToolDefinition } from "./tool_definitions.js";

/**
 * Node pairing and credential administration.
 *
 * These tools issue and revoke node bearer credentials, so they stay on the
 * internal administrator boundary and are never exposed to external callers.
 * Responses never carry the raw credential, the device code or the hash.
 */
export const nodePairingTools = {
  approve_node_pairing: {
    name: "approve_node_pairing",
    audience: "internal",
    strictInputSchema: true,
    config: {
      description:
        "장치에 표시된 승인 코드를 승인해 새 노드의 자격 증명을 발급합니다. 이미 승인된 코드는 같은 결과를 돌려주고 새 자격 증명을 만들지 않습니다.",
      inputSchema: {
        user_code: z.string().min(1),
      },
    },
  },
  list_node_credentials: {
    name: "list_node_credentials",
    audience: "internal",
    strictInputSchema: true,
    config: {
      description: "노드 자격 증명 목록을 조회합니다. 취소된 자격 증명은 include_revoked로 포함합니다.",
      inputSchema: {
        include_revoked: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
  },
  revoke_node_credential: {
    name: "revoke_node_credential",
    audience: "internal",
    strictInputSchema: true,
    config: {
      description: "노드 자격 증명을 취소합니다. 이미 취소된 자격 증명은 같은 취소 시각을 돌려줍니다.",
      inputSchema: {
        credential_id: z.string().uuid(),
      },
    },
  },
} as const satisfies Record<string, McpToolDefinition>;
