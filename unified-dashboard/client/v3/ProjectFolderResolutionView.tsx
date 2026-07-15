import { Button } from "@seosoyoung/soul-ui";

import type { ProjectFolderResolution } from "./use-project-folder-controller";
import { V3ErrorNotice } from "./V3ErrorNotice";

export function ProjectFolderResolutionView({
  state,
  title,
  onRetry,
}: {
  state: ProjectFolderResolution;
  title: string;
  onRetry(): void;
}) {
  if (state.status === "idle" || (state.status === "ready" && state.project)) return null;

  if (state.status === "loading") {
    return (
      <section className="v3-load-error" data-testid="v3-project-loading" aria-busy="true">
        <h1>{title}</h1>
        <p>불러오는 중…</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="v3-load-error" data-testid="v3-project-error">
        <h1>{title}</h1>
        <V3ErrorNotice message="프로젝트를 열지 못했습니다." detail={state.message}>
          <Button variant="secondary" onClick={onRetry}>다시 시도</Button>
        </V3ErrorNotice>
      </section>
    );
  }

  return (
    <section className="v3-load-error" data-testid="v3-empty-project-view">
      <h1>{title}</h1>
      <p>내용이 없습니다.</p>
    </section>
  );
}
