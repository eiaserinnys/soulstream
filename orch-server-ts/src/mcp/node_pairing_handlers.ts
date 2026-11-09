import { errorResult, jsonResult, type CallToolResult } from "@soulstream/mcp-contract";

import { NodePairingError } from "../node_credentials/pairing_service.js";
import type { McpCallContext, McpHostOptions, McpToolHandler } from "./types.js";

type Handler = McpToolHandler;

export const nodePairingHandlers = {
  approve_node_pairing: async (options: McpHostOptions, args: Record<string, unknown>, _context: McpCallContext) => {
    const dependency = options.nodePairing;
    if (dependency === undefined) return errorResult("node pairing is not configured");
    try {
      return jsonResult(await dependency.approve(String(args.user_code)));
    } catch (error) {
      return pairingErrorResult(error);
    }
  },
  list_node_credentials: async (options: McpHostOptions, args: Record<string, unknown>, _context: McpCallContext) => {
    const dependency = options.nodePairing;
    if (dependency === undefined) return errorResult("node pairing is not configured");
    try {
      return jsonResult(await dependency.list(args.include_revoked === true));
    } catch (error) {
      return pairingErrorResult(error);
    }
  },
  revoke_node_credential: async (options: McpHostOptions, args: Record<string, unknown>, _context: McpCallContext) => {
    const dependency = options.nodePairing;
    if (dependency === undefined) return errorResult("node pairing is not configured");
    try {
      return jsonResult(await dependency.revoke(String(args.credential_id)));
    } catch (error) {
      return pairingErrorResult(error);
    }
  },
} satisfies Record<
  "approve_node_pairing" | "list_node_credentials" | "revoke_node_credential",
  Handler
>;

function pairingErrorResult(error: unknown): CallToolResult {
  if (error instanceof NodePairingError) {
    return errorResult(error.message, {
      code: `node_pairing_${error.code}`,
      ...(error.conflictReason === undefined
        ? {}
        : { details: { reason: error.conflictReason } }),
    });
  }
  return errorResult(error instanceof Error ? error.message : String(error));
}
