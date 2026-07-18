import { useRef, useState, type PointerEvent } from "react";

import { DisclosureActionIcon } from "../components/DisclosureActionIcon";
import { cn } from "../lib/cn";
import type { TaskChecklistMutation } from "../stores/task-mutations";
import {
  type TaskItemRow,
  type TaskSectionRow,
  type TaskSnapshot,
  useTaskStore,
} from "../stores/task-store";
import {
  ItemEditorForm,
  QuietAddButton,
  TaskRowActions,
  SectionTitleForm,
  type RowAction,
} from "./TaskChecklistControls";
import { TaskItemRowView } from "./TaskChecklistItem";

type SectionEditor = { mode: "create" } | { mode: "update"; sectionId: string };
type ItemEditor =
  | { mode: "create"; sectionId: string }
  | { mode: "update"; sectionId: string; itemId: string };

export function TaskChecklist({
  snapshot,
  sections,
  itemsBySection,
  textSize,
  editable,
}: {
  snapshot: TaskSnapshot;
  sections: readonly TaskSectionRow[];
  itemsBySection: ReadonlyMap<string, TaskItemRow[]>;
  textSize: "compact" | "session";
  editable: boolean;
}) {
  const mutateChecklist = useTaskStore((state) => state.mutateChecklist);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({});
  const [sectionEditor, setSectionEditor] = useState<SectionEditor | null>(null);
  const [itemEditor, setItemEditor] = useState<ItemEditor | null>(null);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const pendingRef = useRef(false);

  async function mutate(input: TaskChecklistMutation, onSuccess?: () => void) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setMutationError(null);
    try {
      await mutateChecklist(input);
      onSuccess?.();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function sectionActions(section: TaskSectionRow, index: number): RowAction[] {
    const previous = sections[index - 1];
    const next = sections[index + 1];
    return [
      {
        key: "edit",
        label: "이름 편집",
        icon: "edit",
        disabled: pending,
        onSelect: () => {
          setMutationError(null);
          setSectionEditor({ mode: "update", sectionId: section.id });
        },
      },
      {
        key: "add-item",
        label: "항목 추가",
        icon: "add",
        disabled: pending,
        onSelect: () => {
          setMutationError(null);
          setOpenSections((value) => ({ ...value, [section.id]: true }));
          setItemEditor({ mode: "create", sectionId: section.id });
        },
      },
      {
        key: "up",
        label: "위로 이동",
        icon: "up",
        disabled: !previous || pending,
        onSelect: () => void mutate({
          kind: "move_section",
          taskId: snapshot.task.id,
          sectionId: section.id,
          expectedVersion: section.version,
          beforeSectionId: previous?.id,
          idempotencyKey: keyFor("move-section", section.id, section.version),
        }),
      },
      {
        key: "down",
        label: "아래로 이동",
        icon: "down",
        disabled: !next || pending,
        onSelect: () => void mutate({
          kind: "move_section",
          taskId: snapshot.task.id,
          sectionId: section.id,
          expectedVersion: section.version,
          afterSectionId: next?.id,
          idempotencyKey: keyFor("move-section", section.id, section.version),
        }),
      },
      {
        key: "archive",
        label: "섹션 아카이브",
        icon: "archive",
        destructive: true,
        disabled: pending,
        onSelect: () => {
          if (!confirmArchive(`‘${section.title}’ 섹션을 아카이브할까요? 포함된 항목은 목록에서 함께 숨겨집니다.`)) return;
          void mutate({
            kind: "archive_section",
            taskId: snapshot.task.id,
            sectionId: section.id,
            expectedVersion: section.version,
            idempotencyKey: keyFor("archive-section", section.id, section.version),
          });
        },
      },
    ];
  }

  function itemActions(
    section: TaskSectionRow,
    item: TaskItemRow,
    siblings: readonly TaskItemRow[],
    index: number,
  ): RowAction[] {
    const previous = siblings[index - 1];
    const next = siblings[index + 1];
    return [
      {
        key: "edit",
        label: "항목 편집",
        icon: "edit",
        disabled: pending,
        onSelect: () => {
          setMutationError(null);
          setItemEditor({ mode: "update", sectionId: section.id, itemId: item.id });
        },
      },
      {
        key: "up",
        label: "위로 이동",
        icon: "up",
        disabled: !previous || pending,
        onSelect: () => void mutate({
          kind: "move_item",
          taskId: snapshot.task.id,
          sectionId: section.id,
          itemId: item.id,
          expectedVersion: item.version,
          beforeItemId: previous?.id,
          idempotencyKey: keyFor("move-item", item.id, item.version),
        }),
      },
      {
        key: "down",
        label: "아래로 이동",
        icon: "down",
        disabled: !next || pending,
        onSelect: () => void mutate({
          kind: "move_item",
          taskId: snapshot.task.id,
          sectionId: section.id,
          itemId: item.id,
          expectedVersion: item.version,
          afterItemId: next?.id,
          idempotencyKey: keyFor("move-item", item.id, item.version),
        }),
      },
      {
        key: "archive",
        label: "항목 아카이브",
        icon: "archive",
        destructive: true,
        disabled: pending,
        onSelect: () => {
          if (!confirmArchive(`‘${item.title}’ 항목을 아카이브할까요?`)) return;
          void mutate({
            kind: "archive_item",
            taskId: snapshot.task.id,
            itemId: item.id,
            expectedVersion: item.version,
            idempotencyKey: keyFor("archive-item", item.id, item.version),
          });
        },
      },
    ];
  }

  return (
    <div className="space-y-5">
      {sections.map((section, sectionIndex) => {
        const sectionItems = itemsBySection.get(section.id) ?? [];
        const open = openSections[section.id]
          ?? sectionDefaultOpen(section, sectionItems);
        const editingSection = sectionEditor?.mode === "update"
          && sectionEditor.sectionId === section.id;
        return (
          <section key={section.id} data-testid="task-section" className="group/section">
            {editingSection ? (
              <SectionTitleForm
                initialTitle={section.title}
                submitLabel="저장"
                pending={pending}
                error={mutationError}
                onCancel={() => { setSectionEditor(null); setMutationError(null); }}
                onSubmit={(title) => void mutate({
                  kind: "update_section",
                  taskId: snapshot.task.id,
                  sectionId: section.id,
                  expectedVersion: section.version,
                  title,
                  idempotencyKey: keyFor("update-section", section.id, section.version),
                }, () => setSectionEditor(null))}
              />
            ) : (
              <div className="group flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  data-testid="task-section-toggle"
                  aria-expanded={open}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left font-semibold text-foreground hover:text-accent-blue focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-blue/60",
                    textSize === "session" ? "text-sm" : "text-xs",
                  )}
                  onPointerDown={stopTileDrag}
                  onClick={() => setOpenSections((value) => ({ ...value, [section.id]: !open }))}
                >
                  <DisclosureActionIcon
                    expanded={open}
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate">{section.title}</span>
                </button>
                {editable ? (
                  <TaskRowActions
                    label={`${section.title} 섹션 메뉴`}
                    actions={sectionActions(section, sectionIndex)}
                    onPointerDown={stopTileDrag}
                  />
                ) : null}
              </div>
            )}

            {open ? (
              <div className="mt-1.5 space-y-1 pl-5">
                {sectionItems.map((item, itemIndex) => {
                  const editingItem = itemEditor?.mode === "update"
                    && itemEditor.itemId === item.id;
                  if (editingItem) {
                    return (
                      <ItemEditorForm
                        key={item.id}
                        initialTitle={item.title}
                        initialHowTo={item.how_to}
                        submitLabel="저장"
                        pending={pending}
                        error={mutationError}
                        onCancel={() => { setItemEditor(null); setMutationError(null); }}
                        onSubmit={(title, howTo) => void mutate({
                          kind: "update_item",
                          taskId: snapshot.task.id,
                          itemId: item.id,
                          expectedVersion: item.version,
                          title,
                          howTo,
                          idempotencyKey: keyFor("update-item", item.id, item.version),
                        }, () => setItemEditor(null))}
                      />
                    );
                  }
                  return (
                    <TaskItemRowView
                      key={item.id}
                      snapshot={snapshot}
                      section={section}
                      item={item}
                      itemOpen={openItems[item.id] === true}
                      textSize={textSize}
                      actions={editable ? itemActions(section, item, sectionItems, itemIndex) : null}
                      onToggleHowTo={() =>
                        setOpenItems((value) => ({
                          ...value,
                          [item.id]: openItems[item.id] !== true,
                        }))}
                    />
                  );
                })}

                {itemEditor?.mode === "create" && itemEditor.sectionId === section.id ? (
                  <ItemEditorForm
                    initialTitle=""
                    initialHowTo=""
                    submitLabel="추가"
                    pending={pending}
                    error={mutationError}
                    onCancel={() => { setItemEditor(null); setMutationError(null); }}
                    onSubmit={(title, howTo) => {
                      const itemId = newId();
                      const last = sectionItems.at(-1);
                      void mutate({
                        kind: "create_item",
                        taskId: snapshot.task.id,
                        sectionId: section.id,
                        itemId,
                        title,
                        howTo,
                        afterItemId: last?.id,
                        idempotencyKey: keyFor("create-item", itemId),
                      }, () => setItemEditor(null));
                    }}
                  />
                ) : null}

                {editable && itemEditor === null ? (
                  <QuietAddButton disabled={pending} onClick={() => {
                    setMutationError(null);
                    setItemEditor({ mode: "create", sectionId: section.id });
                  }}>
                    항목 추가
                  </QuietAddButton>
                ) : null}
              </div>
            ) : null}
          </section>
        );
      })}

      {sectionEditor?.mode === "create" ? (
        <SectionTitleForm
          initialTitle=""
          submitLabel="추가"
          pending={pending}
          error={mutationError}
          onCancel={() => { setSectionEditor(null); setMutationError(null); }}
          onSubmit={(title) => {
            const sectionId = newId();
            const last = sections.at(-1);
            void mutate({
              kind: "create_section",
              taskId: snapshot.task.id,
              sectionId,
              title,
              afterSectionId: last?.id,
              idempotencyKey: keyFor("create-section", sectionId),
            }, () => setSectionEditor(null));
          }}
        />
      ) : null}

      {editable && sectionEditor === null ? (
        <QuietAddButton disabled={pending} onClick={() => {
          setMutationError(null);
          setSectionEditor({ mode: "create" });
        }}>
          섹션 추가
        </QuietAddButton>
      ) : null}

      {mutationError && sectionEditor === null && itemEditor === null ? (
        <div className="text-xs text-accent-red">{mutationError}</div>
      ) : null}
    </div>
  );
}

function sectionDefaultOpen(section: TaskSectionRow, items: readonly TaskItemRow[]): boolean {
  return !section.archived && items.some((item) =>
    item.status !== "completed" && item.status !== "cancelled");
}

function stopTileDrag(event: PointerEvent<HTMLElement>) {
  event.stopPropagation();
}

function confirmArchive(message: string): boolean {
  return globalThis.confirm(message);
}

function newId(): string {
  return globalThis.crypto.randomUUID();
}

function keyFor(operation: string, targetId: string, version?: number): string {
  const versionPart = version === undefined ? "new" : `v${version}`;
  return `task:${operation}:${targetId}:${versionPart}:${newId()}`;
}
