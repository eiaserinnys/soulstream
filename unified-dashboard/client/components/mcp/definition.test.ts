import { describe, expect, it } from "vitest";
import {
  newUnit,
  pendingSecrets,
  readDefinition,
  reference,
  validateUnits,
  writeDefinition,
} from "./definition";

describe("연결 정보 편집", () => {
  it("헤더와 여러 쿼리 참조를 각각 읽고 손실 없이 저장한다", () => {
    const definition = {
      type: "streamable_http" as const,
      config: {
        url: "https://example.invalid/mcp?first=%7B%7Bsecret%3Afirst%7D%7D&second=%7B%7Benv%3ASECOND%7D%7D",
        headers: {
          Authorization: "Bearer {{secret:auth}}",
          Origin: { env: "ORIGIN" },
        },
        timeout: 30,
        cache_tools_list: true,
      },
    };
    const draft = readDefinition(definition);
    expect(draft.units.map(({ kind, name }) => [kind, name])).toEqual([
      ["header", "Authorization"],
      ["header", "Origin"],
      ["query", "first"],
      ["query", "second"],
    ]);
    expect(writeDefinition(draft)).toEqual(definition);
  });
  it("stdio env 참조와 인수 및 기타 설정을 보존한다", () => {
    const definition = {
      name: "worker",
      type: "stdio" as const,
      config: {
        command: "tool",
        args: ["one", "two"],
        env: { ACCESS: "{{secret:access}}" },
        headers: { hidden: "{{secret:other}}" },
        cwd: "/tmp",
        timeout: 15,
      },
    };
    const draft = readDefinition(definition);
    expect(draft.units.map((unit) => unit.name)).toEqual(["ACCESS"]);
    expect(writeDefinition(draft)).toEqual(definition);
  });
  it("값이 없는 새 비밀 참조와 이름 없는 줄은 저장 전에 알려 준다", () => {
    const draft = readDefinition({
      type: "streamable_http",
      config: { url: "https://example.invalid" },
    });
    draft.units.push(
      newUnit({
        kind: "header",
        name: "Authorization",
        value: "{{secret:missing}}",
      }),
    );
    expect(validateUnits([draft], [], {})).toContain("missing");
    expect(validateUnits([draft], ["missing"], {})).toBeNull();
    expect(
      validateUnits([draft], [], { missing: "obviously-fake-value" }),
    ).toBeNull();
    draft.units[0].name = "";
    expect(validateUnits([draft], ["missing"], {})).toContain("이름");
  });
  it("값 없는 쿼리와 조각을 순서대로 보존한다", () => {
    const definition = {
      type: "streamable_http" as const,
      config: {
        url: "https://example.invalid/mcp?flag&key=%7B%7Bsecret%3Akey%7D%7D&tail#section",
      },
    };
    expect(writeDefinition(readDefinition(definition))).toEqual(definition);
  });
  it("이름 입력 전에도 환경 변수 참조 종류를 유지한다", () => {
    expect(reference("{{env:}}")).toEqual({ kind: "env", name: "" });
  });
  it("지운 값 줄의 교체 대기는 저장에 포함하지 않는다", () => {
    const draft = readDefinition({
      type: "streamable_http",
      config: { url: "https://example.invalid" },
    });
    const retained = newUnit({
      kind: "header",
      name: "A",
      value: "{{secret:kept}}",
    });
    const removed = newUnit({
      kind: "header",
      name: "B",
      value: "{{secret:removed}}",
    });
    draft.units.push(retained);
    expect(
      pendingSecrets([draft], {
        [retained.id]: { name: "kept", value: "fake-one" },
        [removed.id]: { name: "removed", value: "fake-two" },
      }),
    ).toEqual({ kept: "fake-one" });
  });
});
