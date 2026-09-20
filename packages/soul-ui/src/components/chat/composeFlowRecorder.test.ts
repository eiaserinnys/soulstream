import { describe, expect, it } from "vitest";

import { createComposeFlowRecorder } from "./composeFlowRecorder";
import type { UiEventDraft, UiEventType } from "../../lib/ui-events";

type Recorded = { type: UiEventType; draft: UiEventDraft | undefined };

function harness() {
  const events: Recorded[] = [];
  let clock = 0;
  let ids = 0;
  const recorder = createComposeFlowRecorder({
    track: (type, draft) => events.push({ type, draft }),
    newId: () => `flow-${++ids}`,
    now: () => (clock += 100),
  });
  return { recorder, events, advance: (ms: number) => { clock += ms; } };
}

describe("compose flow recorder", () => {
  it("starts a flow on the first character of an empty draft", () => {
    const { recorder, events } = harness();
    recorder.textChanged("s1", "", "ㅎ");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("compose_start");
    expect(events[0]?.draft?.target).toEqual({ kind: "session", id: "s1" });
  });

  it("does not restart the flow on every keystroke", () => {
    const { recorder, events } = harness();
    recorder.textChanged("s1", "", "ㅎ");
    recorder.textChanged("s1", "ㅎ", "하");
    recorder.textChanged("s1", "하", "하이");
    expect(events.filter((entry) => entry.type === "compose_start")).toHaveLength(1);
  });

  it("does not start a flow when the draft is cleared", () => {
    const { recorder, events } = harness();
    recorder.textChanged("s1", "하이", "");
    expect(events).toHaveLength(0);
  });

  it("keeps submit and result on the same flow", () => {
    const { recorder, events } = harness();
    recorder.textChanged("s1", "", "하");
    recorder.submitted("s1", 1, "intervention");
    recorder.settled("ok");
    const flowIds = new Set(events.map((entry) => entry.draft?.flowId));
    expect(flowIds.size).toBe(1);
    expect(events.map((entry) => entry.type))
      .toEqual(["compose_start", "compose_submit", "compose_result"]);
  });

  it("measures how long the send took", () => {
    const { recorder, events, advance } = harness();
    // now() 는 호출마다 100 씩 흐른다: submit 에서 100, settle 에서 1400.
    recorder.submitted("s1", 3, "intervention");
    advance(1200);
    recorder.settled("ok");
    expect(events[1]?.draft?.attrs?.durationMs).toBe(1300);
  });

  it("records a failed send without losing the flow identity", () => {
    const { recorder, events } = harness();
    recorder.submitted("s1", 3, "intervention");
    recorder.settled("error", "network");
    expect(events[1]?.draft?.attrs).toMatchObject({ status: "error", errorCode: "network" });
    expect(events[1]?.draft?.flowId).toBe(events[0]?.draft?.flowId);
  });

  it("starts a fresh flow after a send settles", () => {
    const { recorder, events } = harness();
    recorder.textChanged("s1", "", "a");
    recorder.submitted("s1", 1, "intervention");
    recorder.settled("ok");
    recorder.textChanged("s1", "", "b");
    expect(events[0]?.draft?.flowId).not.toBe(events[3]?.draft?.flowId);
  });

  it("records leaving a draft behind as departure, never as cancellation", () => {
    const { recorder, events } = harness();
    recorder.sessionChanged({ key: "s1", text: "쓰다 만 문장" }, null);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("compose_abandon");
    expect(events[0]?.draft?.attrs).toEqual({ draftPresent: true, draftLength: 7 });
  });

  it("says nothing when the abandoned session had no draft", () => {
    const { recorder, events } = harness();
    recorder.sessionChanged({ key: "s1", text: "" }, { key: "s2", draft: "" });
    expect(events).toHaveLength(0);
  });

  it("records coming back to a session that still holds a draft", () => {
    const { recorder, events } = harness();
    recorder.sessionChanged(null, { key: "s2", draft: "돌아옴" });
    expect(events[0]?.type).toBe("compose_resume");
    expect(events[0]?.draft?.attrs).toEqual({ draftPresent: true, draftLength: 3 });
    expect(events[0]?.draft?.target).toEqual({ kind: "session", id: "s2" });
  });

  it("separates the abandoned flow from the resumed one", () => {
    const { recorder, events } = harness();
    recorder.sessionChanged({ key: "s1", text: "가나" }, { key: "s2", draft: "다라마" });
    expect(events.map((entry) => entry.type)).toEqual(["compose_abandon", "compose_resume"]);
    expect(events[0]?.draft?.flowId).not.toBe(events[1]?.draft?.flowId);
  });

  it("never puts the draft text anywhere in the payload", () => {
    const { recorder, events } = harness();
    const secret = "보내지 않은 내밀한 초안";
    recorder.textChanged("s1", "", secret);
    recorder.submitted("s1", secret.length, "intervention");
    recorder.sessionChanged({ key: "s1", text: secret }, { key: "s2", draft: secret });
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});
