const ISOLATION_NOTICE_PREFIX = "이 세션은 격리되어 있습니다. 임시 파일·산출물은 기존 .local/tmp와 .local/artifacts에 쓰십시오.";
const ISOLATION_NOTICE_SUFFIX =
  "쓰기는 소유 워크트리·위 두 디렉터리·공유 격리 캐시에 한정됩니다. 서비스 상태·로그·배포 대기는 observe_node_services, reflect_*와 로그 파일로 봅니다. 시험 DB는 TEST_DATABASE_URL을 씁니다. 서비스 제어·무관한 세션 메시지·다른 세션의 중단·설정 변경은 차단됩니다. npm -g나 pip --user처럼 워크트리·공유 격리 캐시 밖에 설치하는 일은 할 수 없습니다. 필요하거나 막히면 우회하지 말고 위임자에게 보고하십시오.";

export interface IsolationContextNoticeInput {
  /** 기존 세션의 실제 SCRATCH_WORKSPACE_DIR. 새 scratch를 만들지 않는다. */
  scratchWorkspaceDir: string;
  /** 실제 write 가능 경로. 토큰·비밀 파일 경로는 넣지 않는다. */
  writeRoots: readonly string[];
}

/** §12 시작 context 안내. 토큰과 비밀 파일 경로를 넣지 않는다. */
export function buildIsolationContextNotice(
  input: IsolationContextNoticeInput,
): string {
  const roots = [...new Set(input.writeRoots)].sort();
  const scratch = `SCRATCH_WORKSPACE_DIR=\`${input.scratchWorkspaceDir}\`는 그대로입니다.`;
  return `${ISOLATION_NOTICE_PREFIX} ${scratch} ${ISOLATION_NOTICE_SUFFIX}\n쓰기 가능 경로: ${roots.join(", ")}`;
}
