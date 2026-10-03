import { useMemo, useState } from "react";
import { Button, DashboardIconCap, Input } from "@seosoyoung/soul-ui";
import { Layers, RotateCcw, X } from "lucide-react";
import { ComponentsReviewLayout } from "./ComponentsReviewLayout";
import { FolderPanelHeader } from "./WorkspacePanelHeaders";
import { dialoguesInventory, dialoguesSections, type DialogueId } from "./dialogues-inventory";
import { createDialoguesApi } from "./dialogues-api";
import { DialoguesSamples } from "./DialoguesSamples";
import { confirmUserRemoval } from "../components/UserManagementTab";
import { confirmRecurringArchive } from "../components/RecurringJobsTab";
export function DialoguesReviewPage() {
  return (
    <ComponentsReviewLayout syncPreferences={false}>
      <DialoguesReviewContent />
    </ComponentsReviewLayout>
  );
}
function DialoguesReviewContent() {
  const [query, setQuery] = useState(""),
    [active, setActive] = useState<DialogueId | null>(null),
    [version, setVersion] = useState(0),
    [opening, setOpening] = useState(0),
    [notice, setNotice] = useState("실제 창을 열어 비교합니다. 저장·삭제·생성은 이 페이지 안의 샘플에만 적용됩니다.");
  const api = useMemo(() => createDialoguesApi(), [version]);
  const changed = () => setNotice(`샘플 변경 ${api.mutations.length}건 · ${api.mutations.at(-1) ?? "변경 없음"}`);
  const open = (id: DialogueId) => {
    if (id === "confirm-user" || id === "confirm-recurring") {
      const accepted =
        id === "confirm-user"
          ? confirmUserRemoval("sample@example.invalid")
          : confirmRecurringArchive("검수 반복 작업");
      api.record(`${id} · ${accepted ? "확인" : "취소"}`);
      changed();
      return;
    }
    setOpening((value) => value + 1);
    setActive(id);
    setNotice(`${dialoguesInventory.find((item) => item.id === id)!.name} 샘플을 열었습니다.`);
  };
  return (
    <article className="v3-detail-pane v3-detail-pane--inline" data-testid="dialogues-review">
      <FolderPanelHeader
        title="다이얼로그 비교"
        inline
        backLabel="컴포넌트 검수로 돌아가기"
        onBack={() => window.location.assign("/components")}
        onRename={async () => {}}
        actions={
          <>
            <DashboardIconCap
              label="샘플 상태 초기화"
              onClick={() => {
                setActive(null);
                setVersion((value) => value + 1);
                setNotice("샘플 상태를 초기화했습니다.");
              }}
            >
              <RotateCcw className="h-4 w-4" />
            </DashboardIconCap>
            {active ? (
              <DashboardIconCap label="샘플 닫기" onClick={() => setActive(null)}>
                <X className="h-4 w-4" />
              </DashboardIconCap>
            ) : null}
          </>
        }
      />
      <div className="v3-detail-scroll">
        <div className="v3-task-detail-layout">
          <nav className="v3-task-section-nav" aria-label="검수 섹션">
            {dialoguesSections.map((section) => (
              <button
                key={section.id}
                type="button"
                className="v3-task-section-anchor"
                onClick={() => document.getElementById(`dialogues-${section.id}`)?.scrollIntoView({ block: "start" })}
              >
                <Layers className="h-4 w-4" />
                <span>{section.title}</span>
              </button>
            ))}
          </nav>
          <div className="v3-task-detail-content">
            <div className="v3-folder-header-actions">
              <Button variant="link" render={<a href="/dialogues" />}>
                웹
              </Button>
              <Button variant="link" render={<a href="/dialogues/ios" />}>
                iOS
              </Button>
              <Button variant="link" render={<a href="/components" />}>
                컴포넌트 검수
              </Button>
            </div>
            <Input
              aria-label="다이얼로그 이름 검색"
              placeholder="이름 또는 컴포넌트 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <p role="status" className="v3-components-label">
              {notice}
            </p>
            {dialoguesSections.map((section) => (
              <section key={section.id} id={`dialogues-${section.id}`} className="v3-detail-section">
                <div className="v3-detail-section-head">
                  <h3>{section.title}</h3>
                </div>
                <div className="v3-components-samples">
                  {dialoguesInventory
                    .filter(
                      (item) =>
                        item.section === section.id &&
                        `${item.name} ${item.component}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
                    )
                    .map((item) => (
                      <div className="v3-components-sample" data-dialogue={item.id} key={item.id}>
                        <p className="v3-components-label">
                          {item.name} · {item.component}
                        </p>
                        <Button variant="outline" aria-label={`${item.name} 열기`} onClick={() => open(item.id)}>
                          열기
                        </Button>
                        {active === item.id ? (
                          <div data-testid="dialogue-sample">
                            <DialoguesSamples
                              key={`${version}-${opening}-${active}`}
                              id={active}
                              api={api}
                              onChanged={changed}
                              onClose={() => setActive(null)}
                            />
                          </div>
                        ) : null}
                      </div>
                    ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}
