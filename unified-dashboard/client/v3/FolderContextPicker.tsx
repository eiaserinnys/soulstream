import { useState } from "react";
import { AtomNodeSelector, Button } from "@seosoyoung/soul-ui";
import type { InitialFolderContext } from "@seosoyoung/soul-ui/page";

import { estimateContextPayload } from "./context-picker-model";
import {
  SelectedAtomOption,
  withAtomOptions,
  type AtomRenderMode,
} from "./AtomContextOptions";

export function InitialFolderContextPicker({
  value,
  disabled,
  onChange,
}: {
  value: InitialFolderContext;
  disabled: boolean;
  onChange(value: InitialFolderContext): void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"guidance" | "atom">("guidance");
  const [atomNodeId, setAtomNodeId] = useState("");
  const [atomTitle, setAtomTitle] = useState("");
  const estimate = estimateContextPayload([
    ...(value.guidance.trim() ? [value.guidance] : []),
    ...value.atomReferences.map((reference) => `${reference.nodeId}\n${reference.nodeTitle}`),
  ]);

  const selectAtomNode = (nodeId: string, title: string) => {
    setAtomNodeId(nodeId);
    setAtomTitle(title);
    const normalized = nodeId.trim();
    if (!normalized || value.atomReferences.some((reference) => reference.nodeId === normalized)) return;
    onChange({
      ...value,
      atomReferences: [...value.atomReferences, {
        instance: "atom",
        nodeId: normalized,
        nodeTitle: title.trim() || normalized,
        depth: 3,
        titlesOnly: false,
      }],
    });
  };

  const updateAtomOptions = (
    instance: "atom" | "atom-nl",
    nodeId: string,
    depth: number,
    titlesOnly: boolean,
    mode: AtomRenderMode | undefined,
    limit?: number,
  ) => {
    onChange({
      ...value,
      atomReferences: value.atomReferences.map((reference) => (
        reference.instance === instance && reference.nodeId === nodeId
          ? withAtomOptions(reference, depth, titlesOnly, mode, limit)
          : reference
      )),
    });
  };

  return (
    <section className="v3-new-task-context" data-testid="new-task-direct-context">
      <div className="v3-new-task-context-head">
        <span>
          <strong>이 업무에 직접 추가</strong>
          <small>{estimate.count > 0 ? `${estimate.count}건 · ${estimate.label}` : "선택 사항"}</small>
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "컨텍스트 닫기" : "＋ 컨텍스트"}
        </Button>
      </div>
      {open ? (
        <div className="v3-context-picker v3-context-picker--initial">
          <div className="v3-context-tabs" role="tablist" aria-label="새 업무 컨텍스트 종류">
            <button type="button" role="tab" aria-selected={tab === "guidance"} className={tab === "guidance" ? "is-active" : ""} onClick={() => setTab("guidance")}>✦ guidance</button>
            <button type="button" role="tab" aria-selected={tab === "atom"} className={tab === "atom" ? "is-active" : ""} onClick={() => setTab("atom")}>🧠 atom</button>
          </div>
          <div className="v3-context-panel" role="tabpanel">
            {tab === "guidance" ? (
              <label className="v3-initial-guidance">
                <span>업무 직접 guidance</span>
                <textarea
                  rows={4}
                  value={value.guidance}
                  disabled={disabled}
                  aria-label="업무 직접 guidance"
                  placeholder="이 업무에서만 사용할 지침을 적어두세요."
                  onChange={(event) => onChange({ ...value, guidance: event.target.value })}
                />
              </label>
            ) : (
              <>
                <AtomNodeSelector
                  value={atomNodeId}
                  selectedTitle={atomTitle}
                  disabled={disabled}
                  onChange={selectAtomNode}
                />
                <div className="v3-context-options">
                  {value.atomReferences.map((reference) => (
                    <SelectedAtomOption
                      key={`${reference.instance}:${reference.nodeId}`}
                      title={reference.nodeTitle}
                      meta={reference.nodeId}
                      depth={reference.depth}
                      titlesOnly={reference.titlesOnly}
                      mode={reference.mode}
                      limit={reference.limit}
                      disabled={disabled}
                      onOptionsChange={(depth, titlesOnly, mode, limit) => updateAtomOptions(
                        reference.instance,
                        reference.nodeId,
                        depth,
                        titlesOnly,
                        mode,
                        limit,
                      )}
                      onRemove={() => onChange({
                        ...value,
                        atomReferences: value.atomReferences.filter((candidate) => (
                          candidate.instance !== reference.instance || candidate.nodeId !== reference.nodeId
                        )),
                      })}
                    />
                  ))}
                  {value.atomReferences.length === 0 ? <p>추가한 atom 노드가 없습니다.</p> : null}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
