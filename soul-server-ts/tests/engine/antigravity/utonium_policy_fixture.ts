/** 운영 agents.yaml의 utonium 항목과 같은 시험용 목록. */
export const UTONIUM_SEAL_SCRIPTS =
  "/home/eias/migration/netcup-core-bootstrap/prod-state/agent-common-files/skills/seal/scripts";

export const UTONIUM_ALLOWED = [
  "Read",
  "Agent",
  "SendMessage",
  `Bash(python3 ${UTONIUM_SEAL_SCRIPTS}/seal.py spec:*)`,
  `Bash(python3 ${UTONIUM_SEAL_SCRIPTS}/haniel_approve.py:*)`,
  "Write(//home/eias/workspace/.local/tmp/**)",
  "Edit(//home/eias/workspace/.local/tmp/**)",
  "mcp__soulstream__get_card",
  "mcp__soulstream__update_card_now",
  "mcp__soulstream__create_agent_session",
  "mcp__atom__compile_subtree",
];

export const UTONIUM_DENIED = [
  "Glob",
  "Grep",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
  "mcp__soulstream__delete_session",
  "mcp__atom__update_card",
];
