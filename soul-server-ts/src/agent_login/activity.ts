import type { AgentLoginProvider } from "./types.js";

/**
 * 로그인 CLI가 살아 있는 흐름을 공급자별로 알린다. 로그인 서비스가 쓰고, 사용량 확인이 읽는다.
 * 서비스와 사용량 확인이 서로를 몰라도 되게 하는 얇은 공유 값이다(전역이 아니라 조립 때 하나를 만들어 나눠 쓴다).
 */
export class AgentLoginActivity {
  private readonly live = new Map<AgentLoginProvider, Set<string>>();

  mark(provider: AgentLoginProvider, loginId: string, live: boolean): void {
    const ids = this.live.get(provider) ?? new Set<string>();
    if (live) ids.add(loginId);
    else ids.delete(loginId);
    this.live.set(provider, ids);
  }

  isLive(provider: AgentLoginProvider): boolean {
    return (this.live.get(provider)?.size ?? 0) > 0;
  }
}
