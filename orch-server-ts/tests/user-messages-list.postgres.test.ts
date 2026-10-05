import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import {
  DEFAULT_EXCLUDED_USER_MESSAGE_SOURCES,
  EventReadRepository,
  type UserMessageQuery,
} from "../src/control_plane/repositories/event_read_repository.js";

const SINCE = new Date("2026-10-05T01:00:00.000Z");
const UNTIL = new Date("2026-10-05T02:00:00.000Z");
const at = (time: string) => new Date(`2026-10-05T${time}Z`);
const ROW_KEYS = [
  "agent_id", "created_at", "display_name", "email", "event_id", "node_id", "session_id",
  "session_title", "source", "text", "text_chars", "user_id",
];

describe("EventReadRepository.listUserMessages (real Postgres)", () => {
  let h: PagePostgresHarness;
  let repository: EventReadRepository;

  async function put(sessionId: string, id: number, eventType: string, createdAt: Date, payload: Record<string, unknown>) {
    await h.sql`INSERT INTO events(session_id, id, event_type, payload, created_at)
      VALUES (${sessionId}, ${id}, ${eventType}, ${h.sql.json(payload as never)}, ${createdAt})`;
  }
  const message = (source: string | null, text: string | undefined, extra: Record<string, unknown> = {}) => ({
    ...(text === undefined ? {} : { text }),
    ...(source === null ? {} : { caller_info: { source, ...extra } }),
  });
  const query = (overrides: Partial<UserMessageQuery> = {}): UserMessageQuery => ({
    since: SINCE,
    until: UNTIL,
    sources: null,
    excludedSources: DEFAULT_EXCLUDED_USER_MESSAGE_SOURCES,
    offset: 0,
    limit: 100,
    maxTextChars: 2000,
    ...overrides,
  });
  const ids = (rows: { session_id: string; event_id: number }[]) => rows.map((r) => `${r.session_id}#${r.event_id}`);

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    repository = new EventReadRepository(h.sql);
    await h.sql`INSERT INTO sessions(session_id, display_name, node_id, agent_id)
      VALUES ('sess-a', '세션 A', 'eiaserinnys', 'roselin'), ('sess-b', NULL, NULL, NULL)`;
    const longText = "가".repeat(150);
    const emojiText = `${"가".repeat(99)}😀나`;
    // 기본 조회에 나와야 하는 메시지
    await put("sess-a", 1, "user_message", at("01:00:00.000"), message("browser", "브라우저 사용자",
      { email: "u@example.com", user_id: "u1", display_name: "사용자" }));
    await put("sess-a", 2, "user_message", at("01:10:00.000"), message("browser", "카드 커멘트 알림"));
    await put("sess-b", 1, "user_message", at("01:20:00.000"), message("external-llm", "외부 LLM"));
    await put("sess-a", 9, "user_message", at("01:25:00.000"), message("future-source", "새 발신 경로"));
    await put("sess-a", 6, "user_message", at("01:50:00.000"), { ...message("browser", longText), context: "주입 컨텍스트" });
    await put("sess-b", 6, "user_message", at("01:50:00.000"), message("browser", emojiText));
    await put("sess-a", 7, "user_message", at("01:55:00.000"), message("slack", "슬랙 7"));
    await put("sess-a", 8, "user_message", at("01:55:00.000"), message("slack", "슬랙 8"));
    await put("sess-b", 7, "user_message", at("01:55:00.000"), message("slack", "슬랙 7b"));
    // 기본 조회에서 빠져야 하는 메시지
    await put("sess-a", 3, "user_message", at("01:30:00.000"), message("agent", "에이전트 발화"));
    await put("sess-b", 2, "user_message", at("01:35:00.000"), message("system", "시스템 안내"));
    await put("sess-b", 3, "user_message", at("01:40:00.000"), message(null, "발신 정보 없음"));
    await put("sess-b", 4, "user_message", at("01:45:00.000"), message("browser", undefined));
    await put("sess-b", 8, "user_message", at("01:46:00.000"), message("browser", ""));
    await put("sess-a", 4, "user_message", at("00:59:59.999"), message("browser", "기간 이전"));
    await put("sess-b", 5, "user_message", at("02:00:00.000"), message("browser", "until 정각"));
    await put("sess-a", 5, "assistant_message", at("01:50:00.000"), message("browser", "응답 이벤트"));
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("기본 조회는 에이전트·시스템·발신 정보 없음·본문 없음·기간 밖·다른 이벤트를 빼고 시간순으로 돌려준다", async () => {
    const { rows, total } = await repository.listUserMessages(query());
    expect(total).toBe(9);
    // since 정각(a#1)은 포함, until 정각(b#5)은 제외. 같은 시각은 session_id, id 순.
    expect(ids(rows)).toEqual([
      "sess-a#1", "sess-a#2", "sess-b#1", "sess-a#9", "sess-a#6", "sess-b#6", "sess-a#7", "sess-a#8", "sess-b#7",
    ]);
    expect(rows.find((r) => r.session_id === "sess-b" && r.event_id === 1)?.source).toBe("external-llm");
    expect(rows.find((r) => r.event_id === 9)?.source).toBe("future-source");
  });

  it("sources를 주면 기본 제외를 적용하지 않고 그 값의 메시지만 돌려준다", async () => {
    const agentOnly = await repository.listUserMessages(query({ sources: ["agent"], excludedSources: [] }));
    expect(ids(agentOnly.rows)).toEqual(["sess-a#3"]);
    expect(agentOnly.total).toBe(1);
    const several = await repository.listUserMessages(query({ sources: ["system", "agent"], excludedSources: [] }));
    expect(ids(several.rows)).toEqual(["sess-a#3", "sess-b#2"]);
  });

  it("limit와 offset은 같은 정렬 위에서 페이지를 자르고 total은 그대로다", async () => {
    const first = await repository.listUserMessages(query({ limit: 4 }));
    expect(ids(first.rows)).toEqual(["sess-a#1", "sess-a#2", "sess-b#1", "sess-a#9"]);
    expect(first.total).toBe(9);
    const last = await repository.listUserMessages(query({ limit: 4, offset: 8 }));
    expect(ids(last.rows)).toEqual(["sess-b#7"]);
    expect(last.total).toBe(9);
    const beyond = await repository.listUserMessages(query({ offset: 20 }));
    expect(beyond.rows).toEqual([]);
    expect(beyond.total).toBe(9);
  });

  it("상한보다 긴 본문은 글자 단위로 잘리고 text_chars는 자르기 전 길이이며 이모지를 쪼개지 않는다", async () => {
    const { rows } = await repository.listUserMessages(query({ maxTextChars: 100 }));
    const long = rows.find((r) => r.session_id === "sess-a" && r.event_id === 6)!;
    expect(long.text).toBe("가".repeat(100));
    expect(long.text_chars).toBe(150);
    const emoji = rows.find((r) => r.session_id === "sess-b" && r.event_id === 6)!;
    expect(emoji.text).toBe(`${"가".repeat(99)}😀`);
    expect(emoji.text_chars).toBe(101);
    const short = rows.find((r) => r.session_id === "sess-a" && r.event_id === 2)!;
    expect(short.text).toBe("카드 커멘트 알림");
    expect(short.text_chars).toBe([..."카드 커멘트 알림"].length);
  });

  it("행에는 본문과 발신, 세션 필드만 있고 payload의 다른 내용(context 등)은 없다", async () => {
    const { rows } = await repository.listUserMessages(query());
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(JSON.stringify(rows)).not.toContain("주입 컨텍스트");
  });

  it("caller_info와 세션 메타를 채우고 없으면 null이다", async () => {
    const { rows } = await repository.listUserMessages(query());
    const a1 = rows.find((r) => r.session_id === "sess-a" && r.event_id === 1)!;
    expect(a1).toMatchObject({
      source: "browser", email: "u@example.com", user_id: "u1", display_name: "사용자",
      session_title: "세션 A", node_id: "eiaserinnys", agent_id: "roselin",
    });
    expect(a1.created_at).toEqual(SINCE);
    const b1 = rows.find((r) => r.session_id === "sess-b" && r.event_id === 1)!;
    expect(b1).toMatchObject({
      source: "external-llm", email: null, user_id: null, display_name: null,
      session_title: null, node_id: null, agent_id: null,
    });
  });
});
