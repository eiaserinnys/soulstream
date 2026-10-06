import { describe, expect, it } from "vitest";

import {
  SCHEDULE_PROMPT,
  SOURCE_TOOL,
  resumeAfterLimitToolUseId,
  stableScheduleId,
} from "../src/resume_after_limit.js";

describe("resume-after-limit shared schedule identity", () => {
  it("keeps the route schedule constants and terminal identity stable", () => {
    expect(SOURCE_TOOL).toBe("ResumeAfterLimit");
    expect(SCHEDULE_PROMPT).toBe("리밋 해제 시각이 지났습니다. 이전 지시와 미완료 작업을 이어서 진행해주세요.");
    expect(resumeAfterLimitToolUseId(32)).toBe("ResumeAfterLimit:32");
    expect(stableScheduleId("sess-1", 32, 0)).toBe("resume-after-limit:sess-1:32:0");
  });
});
