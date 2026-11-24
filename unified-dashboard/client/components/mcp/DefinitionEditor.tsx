import { useEffect, useId, useRef, useState } from "react";
import { Button, Checkbox, Input } from "@seosoyoung/soul-ui";
import {
  inputControlClassName,
  inputFieldClassName,
} from "@seosoyoung/soul-ui/components/ui/input";
import {
  SettingsField,
  SettingsGroupBox,
  SettingsMultilineField,
} from "../config/SettingsListDetail";
import {
  newUnit,
  reference,
  type DefinitionDraft,
  type Unit,
} from "./definition";
const selectClass = `${inputFieldClassName} h-8.5 leading-8.5 sm:h-7.5 sm:leading-7.5 ps-[calc(--spacing(3)-1px-4px)]`;

export function McpValueUnit({
  unit,
  secretNames = [],
  isolateValue = false,
  onChange,
  onRemove,
  onSecretValue,
}: {
  unit: Unit;
  secretNames?: string[];
  isolateValue?: boolean;
  onChange(value: Unit): void;
  onRemove(): void;
  onSecretValue(name: string, value: string | null): void;
}) {
  const [replace, setReplace] = useState(false);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const original = useRef(unit.value);
  const ref = reference(unit.value);
  const referenceInput = useRef<HTMLInputElement>(null);
  const [referenceOverflow, setReferenceOverflow] = useState(false);
  const [showReference, setShowReference] = useState(false);
  useEffect(() => {
    const input = referenceInput.current;
    if (!input) return;
    const measure = () =>
      setReferenceOverflow(input.scrollWidth > input.clientWidth + 1);
    measure();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [ref.name]);
  const updateReference = (kind: "secret" | "env", name: string) => {
    if (ref.kind === "secret" && ref.name) onSecretValue(ref.name, null);
    setReplace(false);
    const pattern = /\{\{(?:secret|env):[^}]*\}\}/;
    const next = `{{${kind}:${name}}}`;
    onChange({
      ...unit,
      value:
        typeof unit.value === "string" && pattern.test(unit.value)
          ? unit.value.replace(pattern, next)
          : next,
    });
  };
  return (
    <div
      data-testid="mcp-value-unit"
      className="grid min-w-0 gap-2 rounded-floor bg-muted/20 p-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !replace) return;
        event.stopPropagation();
        const previous = reference(original.current);
        if (previous.kind === "secret") onSecretValue(previous.name, null);
        onChange({ ...unit, value: original.current });
        setReplace(false);
        replaceButton.current?.focus();
      }}
    >
      <div className="grid min-w-0 gap-2">
        <SettingsField
          label={
            unit.kind === "header"
              ? "헤더 이름"
              : unit.kind === "query"
                ? "쿼리 이름"
                : "환경 변수 이름"
          }
        >
          <Input
            value={unit.name}
            onChange={(event) =>
              onChange({ ...unit, name: event.target.value })
            }
          />
        </SettingsField>
        <SettingsField label="참조">
          <span className="grid min-w-0 gap-1">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={`${inputControlClassName} shrink-0`}
                style={{ width: "auto" }}
                data-slot="input-control"
              >
                <select
                  aria-label="참조 종류"
                  value={ref.kind === "literal" ? "secret" : ref.kind}
                  onChange={(event) =>
                    updateReference(
                      event.target.value as "secret" | "env",
                      ref.name,
                    )
                  }
                  className={selectClass}
                >
                  <option value="secret">비밀</option>
                  <option value="env">환경 변수</option>
                </select>
              </span>
            </span>
            <Input
              ref={referenceInput}
              aria-label="참조 이름"
              className="min-w-0"
              title={ref.name}
              list={ref.kind !== "env" ? listId : undefined}
              value={ref.name}
              onChange={(event) =>
                updateReference(
                  ref.kind === "env" ? "env" : "secret",
                  event.target.value,
                )
              }
            />
            <datalist id={listId}>
              {secretNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {ref.kind === "secret" ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {secretNames.includes(ref.name) ? "DB에 저장됨" : "DB에 없음"}
              </span>
            ) : null}
          </span>
        </SettingsField>
        {referenceOverflow ? (
          <div className="space-y-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={showReference}
              onClick={() => setShowReference(!showReference)}
              data-testid="mcp-reference-full-toggle"
            >
              {showReference ? "참조 이름 접기" : "참조 이름 전체 보기"}
            </Button>
            {showReference ? (
              <p data-v3-selectable-content="true" className="break-all text-sm">
                {ref.name}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={replaceButton}
          type="button"
          variant="outline"
          onClick={() => {
            if (replace) {
              const previous = reference(original.current);
              if (previous.kind === "secret")
                onSecretValue(previous.name, null);
              onChange({ ...unit, value: original.current });
            } else original.current = unit.value;
            setReplace(!replace);
          }}
        >
          {replace ? "교체 취소" : "값 교체"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const previous = reference(replace ? original.current : unit.value);
            if (previous.kind === "secret") onSecretValue(previous.name, null);
            onRemove();
          }}
        >
          줄 빼기
        </Button>
      </div>
      {replace ? (
        <SettingsField label="새 값">
          <Input
            type="password"
            autoFocus
            autoComplete="off"
            defaultValue=""
            onChange={(event) => {
              const previous = reference(original.current);
              if (!isolateValue && previous.kind === "secret" && previous.name)
                onSecretValue(previous.name, event.target.value);
              else {
                const pattern = /\{\{(?:secret|env):[^}]*\}\}/;
                const next =
                  typeof original.current === "string" &&
                  pattern.test(original.current)
                    ? original.current.replace(
                        pattern,
                        () => event.target.value,
                      )
                    : event.target.value;
                onChange({ ...unit, value: next });
              }
            }}
          />
        </SettingsField>
      ) : null}
    </div>
  );
}

export function DefinitionEditor({
  value,
  secretNames,
  isolateValue = false,
  onChange,
  onSecretValue,
}: {
  value: DefinitionDraft;
  secretNames: string[];
  isolateValue?: boolean;
  onChange(next: DefinitionDraft): void;
  onSecretValue(unitId: string, name: string, value: string | null): void;
}) {
  const [newKind, setNewKind] = useState<Unit["kind"] | "bearer">(
    value.type === "stdio" ? "env" : "header",
  );
  const effectiveKind =
    value.type === "stdio" ? "env" : newKind === "env" ? "header" : newKind;
  const setConfig = (key: string, next: unknown) => {
    const config = { ...value.config };
    if (key === "command" && typeof next === "string" && next)
      delete config.full_command;
    if (next === "" || next === undefined) delete config[key];
    else config[key] = next;
    onChange({ ...value, config });
  };
  return (
    <SettingsGroupBox title="연결 및 인증">
      <div className="space-y-3">
        <SettingsField label="전송 방식">
          <span className={inputControlClassName} data-slot="input-control">
            <select
              aria-label="전송 방식"
              value={value.type}
              onChange={(event) => {
                const type = event.target.value as DefinitionDraft["type"];
                setNewKind(type === "stdio" ? "env" : "header");
                onChange({ ...value, type });
              }}
              className={selectClass}
            >
              <option value="streamable_http">streamable_http</option>
              <option value="sse">sse</option>
              <option value="stdio">stdio</option>
            </select>
          </span>
        </SettingsField>
        {value.type === "stdio" ? (
          <>
            <SettingsField label="command">
              <Input
                value={String(value.config.command ?? "")}
                onChange={(event) => setConfig("command", event.target.value)}
              />
            </SettingsField>
            <SettingsMultilineField
              label="args (한 줄에 하나)"
              value={
                Array.isArray(value.config.args)
                  ? value.config.args.join("\n")
                  : ""
              }
              onChange={(next) =>
                setConfig("args", next ? next.split("\n") : [])
              }
            />
            <SettingsField label="cwd">
              <Input
                value={String(value.config.cwd ?? "")}
                onChange={(event) => setConfig("cwd", event.target.value)}
              />
            </SettingsField>
          </>
        ) : (
          <SettingsField label="URL">
            <Input
              value={value.url}
              onChange={(event) =>
                onChange({ ...value, url: event.target.value })
              }
            />
          </SettingsField>
        )}
        {value.units.map((unit, index) => (
          <McpValueUnit
            key={unit.id}
            unit={unit}
            secretNames={secretNames}
            isolateValue={isolateValue}
            onSecretValue={(name, next) => onSecretValue(unit.id, name, next)}
            onChange={(next) =>
              onChange({
                ...value,
                units: value.units.map((current, i) =>
                  i === index ? next : current,
                ),
              })
            }
            onRemove={() =>
              onChange({
                ...value,
                units: value.units.filter((_, i) => i !== index),
              })
            }
          />
        ))}
        <div className="space-y-1">
          {value.type !== "stdio" ? (
            <span className="text-sm text-muted-foreground">인증 방식</span>
          ) : null}
          <div className="flex items-center gap-2">
            {value.type !== "stdio" ? (
              <span
                className={`${inputControlClassName} shrink-0`}
                style={{ width: "auto" }}
                data-slot="input-control"
              >
                <select
                  aria-label="인증 방식"
                  value={effectiveKind}
                  onChange={(event) =>
                    setNewKind(event.target.value as Unit["kind"] | "bearer")
                  }
                  className={selectClass}
                >
                  <option value="header">헤더</option>
                  <option value="bearer">Bearer</option>
                  <option value="query">쿼리</option>
                </select>
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                onChange({
                  ...value,
                  units: [
                    ...value.units,
                    newUnit(
                      effectiveKind === "bearer"
                        ? {
                            kind: "header",
                            name: "Authorization",
                            value: "Bearer {{secret:}}",
                          }
                        : { kind: effectiveKind, name: "", value: "{{secret:}}" },
                    ),
                  ],
                })
              }
            >
              줄 더하기
            </Button>
          </div>
        </div>
        <SettingsField label="타임아웃">
          <Input
            type="number"
            min="1"
            value={String(value.config.timeout ?? "")}
            onChange={(event) =>
              setConfig(
                "timeout",
                event.target.value ? Number(event.target.value) : undefined,
              )
            }
          />
        </SettingsField>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={Boolean(value.config.cache_tools_list)}
            onCheckedChange={(checked) =>
              setConfig("cache_tools_list", checked)
            }
          />
          도구 목록 캐시
        </label>
      </div>
    </SettingsGroupBox>
  );
}
