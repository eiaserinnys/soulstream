import test from "node:test";
import assert from "node:assert/strict";
import { NODE_ID_PATTERN, PairingError, defaultNodeId, validateNodeId } from "../lib/pairing.mjs";

test("노드 이름은 P1 규칙(영문 소문자·숫자·'-', 2~63자)을 따른다", () => {
  for (const name of ["ab", "a1", "portable-test-node", "9lives", "a".repeat(63), "a-b-c-1"]) {
    assert.equal(validateNodeId(name), name);
    assert.match(name, NODE_ID_PATTERN);
  }
  const invalid = ["", "a", "A", "Abc", "-abc", "a b", "a_b", "한글", "a".repeat(64), "a/b"];
  for (const name of invalid) {
    assert.throws(() => validateNodeId(name), (error) => error instanceof PairingError && error.code === "INVALID_NODE_ID", name);
  }
});

test("기본 노드 이름은 어떤 호스트 이름에서도 규칙을 만족한다", () => {
  const hostnames = [
    "My-PC",
    "DESKTOP-1234",
    "eiaserinnys",
    "x",
    "",
    "!!!",
    "한글호스트",
    "a".repeat(120),
    "-leading-and-trailing-",
    "host_name.example.com",
  ];
  for (const hostname of hostnames) {
    const name = defaultNodeId(hostname);
    assert.match(name, NODE_ID_PATTERN, `${JSON.stringify(hostname)} → ${name}`);
    assert.ok(name.length >= 2 && name.length <= 63, name);
    assert.equal(name.endsWith("-"), false);
  }
  assert.equal(defaultNodeId(""), "portable-node");
  assert.equal(defaultNodeId("x"), "portable-node");
  assert.equal(defaultNodeId("!!! "), "portable-node");
  assert.equal(defaultNodeId("My-PC"), "my-pc");
  const longName = defaultNodeId(`${"a".repeat(80)}-tail`);
  assert.equal(longName.length, 63);
  assert.match(longName, NODE_ID_PATTERN);
});
