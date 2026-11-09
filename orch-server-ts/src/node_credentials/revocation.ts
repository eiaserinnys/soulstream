/**
 * Shared close policy for sockets authenticated by a node pairing credential.
 * Revoking a credential must end the sessions it opened on every transport
 * (node websocket, control websocket, page Yjs), using one code and reason.
 */
export const NODE_CREDENTIAL_REVOKED_CLOSE_CODE = 1008;
export const NODE_CREDENTIAL_REVOKED_REASON = "node credential revoked";
