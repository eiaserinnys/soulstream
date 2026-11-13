import type { UsageSummarySnapshot } from "./usage_summary_service.js";

export type ClaudeAccountReloginAlert = {
  readonly nodeId: string;
  readonly accountId: string;
  readonly accountEmail: string;
};

/**
 * 사용량 스냅샷에서 계정이 정상에서 needs_relogin으로 넘어간 순간을 한 번만 알린다.
 * 직전 값은 메모리에만 둔다. 처음 보는 계정은 기록만 해서 오케스트레이터가 재시작될 때마다
 * 이미 끊긴 계정을 다시 알리지 않는다.
 */
export class ClaudeAccountReloginNotifier {
  private readonly previousAuthStates = new Map<string, string>();

  constructor(private readonly notify: (alert: ClaudeAccountReloginAlert) => void) {}

  observe(snapshot: UsageSummarySnapshot): void {
    for (const node of snapshot.nodes) {
      for (const account of node.providers.claude?.accounts ?? []) {
        const key = `${node.nodeId}\u0000${account.id}`;
        const previous = this.previousAuthStates.get(key);
        this.previousAuthStates.set(key, account.auth_state);
        if (
          previous !== undefined
          && previous !== "needs_relogin"
          && previous !== "logging_in"
          && account.auth_state === "needs_relogin"
          && account.enabled
        ) {
          this.notify({ nodeId: node.nodeId, accountId: account.id, accountEmail: account.email });
        }
      }
    }
  }
}
