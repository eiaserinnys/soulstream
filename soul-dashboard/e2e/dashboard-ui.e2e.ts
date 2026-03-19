/**
 * Soul Dashboard 브라우저 UI E2E 테스트
 *
 * 실제 브라우저에서 대시보드를 렌더링하고 각 단계마다 스크린샷을 캡처합니다.
 * 빌드된 클라이언트(dist/client/)를 Mock Express 서버에서 직접 서빙하며,
 * Mock API 엔드포인트(세션 목록, SSE 이벤트)도 같은 서버에서 제공합니다.
 *
 * 사전 요건: `npx vite build` 실행으로 dist/client/ 생성
 * 실행: cd src/soul-dashboard && npx playwright test dashboard-ui --config=playwright.config.ts
 */

import { test as base, expect, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createServer, type Server } from "http";
import type {
  CreateSessionResponse,
  InterveneResponse,
} from "../shared/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === SSE 이벤트 타이밍 상수 ===

const SSE_INTERVAL = 200;

// === 멀티 Tool SSE 이벤트 시퀀스 ===

/**
 * 3개의 연속 Tool 호출(Read → Write → Bash)을 포함하는 SSE 이벤트 시퀀스.
 * thinking → 3개 tool 호출 → 2번째 thinking → response → complete
 */
const MULTI_TOOL_SSE_EVENTS = [
  // 0) User message
  {
    delay: 0,
    data: 'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"src/utils.ts에 validateInput 함수를 추가하고 테스트를 실행해주세요."}\n\n',
  },
  // 1) Thinking: 분석
  {
    delay: 1 * SSE_INTERVAL,
    data: 'id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"mt-t1","parent_event_id":"0"}\n\n',
  },
  {
    delay: 2 * SSE_INTERVAL,
    data: 'id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"mt-t1","text":"먼저 기존 파일을 읽고, 수정한 뒤, 테스트를 실행하겠습니다."}\n\n',
  },
  {
    delay: 3 * SSE_INTERVAL,
    data: 'id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"mt-t1"}\n\n',
  },
  // 2) Tool 1: Read
  {
    delay: 4 * SSE_INTERVAL,
    data: 'id: 4\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt-tool1","tool_name":"Read","tool_input":{"file_path":"/src/utils.ts"},"parent_event_id":"0"}\n\n',
  },
  {
    delay: 5 * SSE_INTERVAL,
    data: 'id: 5\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt-tool1","tool_name":"Read","result":"export function formatDate(d: Date) { return d.toISOString(); }","is_error":false}\n\n',
  },
  // 3) Tool 2: Write
  {
    delay: 6 * SSE_INTERVAL,
    data: 'id: 6\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt-tool2","tool_name":"Write","tool_input":{"file_path":"/src/utils.ts","content":"export function validateInput(s: string) { return s.trim().length > 0; }"},"parent_event_id":"0"}\n\n',
  },
  {
    delay: 7 * SSE_INTERVAL,
    data: 'id: 7\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt-tool2","tool_name":"Write","result":"File written successfully","is_error":false}\n\n',
  },
  // 4) Tool 3: Bash
  {
    delay: 8 * SSE_INTERVAL,
    data: 'id: 8\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt-tool3","tool_name":"Bash","tool_input":{"command":"npm test -- --filter=utils"},"parent_event_id":"0"}\n\n',
  },
  {
    delay: 9 * SSE_INTERVAL,
    data: 'id: 9\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt-tool3","tool_name":"Bash","result":"PASS src/utils.test.ts\\n  validateInput\\n    ✓ returns true for valid input (2ms)\\n    ✓ returns false for empty string (1ms)","is_error":false}\n\n',
  },
  // 5) 두 번째 Thinking
  {
    delay: 10 * SSE_INTERVAL,
    data: 'id: 10\nevent: text_start\ndata: {"type":"text_start","card_id":"mt-t2","parent_event_id":"0"}\n\n',
  },
  {
    delay: 11 * SSE_INTERVAL,
    data: 'id: 11\nevent: text_delta\ndata: {"type":"text_delta","card_id":"mt-t2","text":"validateInput 함수를 추가하고 테스트가 모두 통과했습니다."}\n\n',
  },
  {
    delay: 12 * SSE_INTERVAL,
    data: 'id: 12\nevent: text_end\ndata: {"type":"text_end","card_id":"mt-t2"}\n\n',
  },
  // 6) Complete
  {
    delay: 14 * SSE_INTERVAL,
    data: 'id: 13\nevent: complete\ndata: {"type":"complete","result":"src/utils.ts에 validateInput 함수를 추가하고 테스트를 통과했습니다.","attachments":[],"parent_event_id":"0"}\n\n',
    end: true,
  },
];

const SSE_EVENTS = [
  // 0) User message
  {
    delay: 0,
    data: 'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"src/index.ts 파일을 분석하고 에러 핸들링을 추가해주세요."}\n\n',
  },
  // 1) Thinking 카드: text_start → text_delta → text_end
  {
    delay: 1 * SSE_INTERVAL,
    data: 'id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"card-t1","parent_event_id":"0"}\n\n',
  },
  {
    delay: 2 * SSE_INTERVAL,
    data: 'id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"card-t1","text":"파일 구조를 분석하겠습니다. src/index.ts를 먼저 확인하고 의존성을 추적합니다."}\n\n',
  },
  {
    delay: 3 * SSE_INTERVAL,
    data: 'id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"card-t1"}\n\n',
  },
  // 2) Tool 호출: tool_start → tool_result
  {
    delay: 4 * SSE_INTERVAL,
    data: 'id: 4\nevent: tool_start\ndata: {"type":"tool_start","card_id":"card-tool1","tool_name":"Read","tool_input":{"file_path":"/src/index.ts"},"parent_event_id":"0"}\n\n',
  },
  {
    delay: 6 * SSE_INTERVAL,
    data: 'id: 5\nevent: tool_result\ndata: {"type":"tool_result","card_id":"card-tool1","tool_name":"Read","result":"export function main() {\\n  console.log(\\"hello\\");\\n}","is_error":false}\n\n',
  },
  // 3) 두 번째 Thinking 카드
  {
    delay: 7 * SSE_INTERVAL,
    data: 'id: 6\nevent: text_start\ndata: {"type":"text_start","card_id":"card-t2","parent_event_id":"0"}\n\n',
  },
  {
    delay: 8 * SSE_INTERVAL,
    data: 'id: 7\nevent: text_delta\ndata: {"type":"text_delta","card_id":"card-t2","text":"파일을 확인했습니다. main 함수를 수정하여 에러 핸들링을 추가하겠습니다."}\n\n',
  },
  {
    delay: 9 * SSE_INTERVAL,
    data: 'id: 8\nevent: text_end\ndata: {"type":"text_end","card_id":"card-t2"}\n\n',
  },
  // 4) Complete 이벤트
  {
    delay: 11 * SSE_INTERVAL,
    data: 'id: 9\nevent: complete\ndata: {"type":"complete","result":"작업이 완료되었습니다. src/index.ts에 에러 핸들링을 추가했습니다.","attachments":[],"parent_event_id":"0"}\n\n',
    end: true,
  },
];

// === Tool 없는 세션 SSE 이벤트 시퀀스 ===

/**
 * Tool call 없이 thinking → response → complete만 있는 세션.
 * Bug #10 회귀 테스트: 세로 배치 겹침 검증.
 */
const NO_TOOL_SSE_EVENTS = [
  {
    delay: 0,
    data: 'id: 0\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"간단히 설명해주세요."}\n\n',
  },
  {
    delay: 1 * SSE_INTERVAL,
    data: 'id: 1\nevent: text_start\ndata: {"type":"text_start","card_id":"nt-t1","parent_event_id":"0"}\n\n',
  },
  {
    delay: 2 * SSE_INTERVAL,
    data: 'id: 2\nevent: text_delta\ndata: {"type":"text_delta","card_id":"nt-t1","text":"이것은 도구를 사용하지 않고 바로 답변하는 세션입니다."}\n\n',
  },
  {
    delay: 3 * SSE_INTERVAL,
    data: 'id: 3\nevent: text_end\ndata: {"type":"text_end","card_id":"nt-t1"}\n\n',
  },
  {
    delay: 5 * SSE_INTERVAL,
    data: 'id: 4\nevent: complete\ndata: {"type":"complete","result":"답변을 완료했습니다.","attachments":[],"parent_event_id":"0"}\n\n',
    end: true,
  },
];

// === 25+ 노드 세션 SSE 이벤트 시퀀스 ===

/** 10쌍의 thinking+tool을 생성 → ~25 노드 */
function generateLargeSSEEvents(pairCount: number): Array<{ delay: number; data: string; end?: boolean }> {
  const events: Array<{ delay: number; data: string; end?: boolean }> = [];
  let id = 0;
  let step = 0;

  // user message (id=0, 자식들의 parent_event_id 기준)
  const userMsgId = id;
  events.push({
    delay: 0,
    data: `id: ${id++}\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"대규모 작업을 수행해주세요 (${pairCount} 단계)."}\n\n`,
  });

  for (let i = 0; i < pairCount; i++) {
    step++;
    // thinking
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"lg-t${i}","parent_event_id":"${userMsgId}"}\n\n`,
    });
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"lg-t${i}","text":"Step ${i}: 분석 중..."}\n\n`,
    });
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"lg-t${i}"}\n\n`,
    });

    // tool
    const toolName = ["Read", "Bash", "Glob", "Grep", "Write"][i % 5];
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: tool_start\ndata: {"type":"tool_start","card_id":"lg-tool${i}","tool_name":"${toolName}","tool_input":{"command":"step-${i}"},"parent_event_id":"${userMsgId}"}\n\n`,
    });
    step++;
    events.push({
      delay: step * SSE_INTERVAL,
      data: `id: ${id++}\nevent: tool_result\ndata: {"type":"tool_result","card_id":"lg-tool${i}","tool_name":"${toolName}","result":"Result of step ${i}","is_error":false}\n\n`,
    });
  }

  // final thinking + complete
  step++;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"lg-final","parent_event_id":"${userMsgId}"}\n\n`,
  });
  step++;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"lg-final","text":"모든 단계를 완료했습니다."}\n\n`,
  });
  step++;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"lg-final"}\n\n`,
  });
  step += 2;
  events.push({
    delay: step * SSE_INTERVAL,
    data: `id: ${id++}\nevent: complete\ndata: {"type":"complete","result":"${pairCount}단계 작업 완료","attachments":[],"parent_event_id":"${userMsgId}"}\n\n`,
    end: true,
  });

  return events;
}

const LARGE_25_SSE_EVENTS = generateLargeSSEEvents(10);  // ~25 노드
const LARGE_50_SSE_EVENTS = generateLargeSSEEvents(20);  // ~50 노드

// === 멀티턴 세션 SSE 이벤트 시퀀스 ===

/**
 * 실제 sess-mm9c1n23-lqfg.jsonl의 구조를 재현하는 멀티턴 시퀀스.
 *
 * Turn 1: user_message → thinking → tool(Skill) → text(response) → complete
 * Turn 2: user_message → thinking → text → 5개 tool 호출 → (진행 중, complete 없음)
 *
 * complete는 "턴 종료"이지 "세션 종료"가 아님.
 * Turn 2의 이벤트가 Turn 1의 complete 이후에도 모두 수신되어야 함.
 */
function generateMultiTurnSSEEvents(): Array<{ delay: number; data: string; end?: boolean }> {
  const events: Array<{ delay: number; data: string; end?: boolean }> = [];
  let id = 0;
  const d = 50; // 짧은 간격 (E2E 속도)

  // === Turn 1 ===
  const turn1UserId = id;
  events.push({ delay: 0,
    data: `id: ${id++}\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"대사 작업 스킬을 로드하고 다음 지시를 대기."}\n\n` });
  // thinking
  events.push({ delay: d,
    data: `id: ${id++}\nevent: thinking\ndata: {"type":"thinking","card_id":"mt2-think1","thinking":"Loading dialogue skill.","parent_event_id":"${turn1UserId}"}\n\n` });
  // tool: Skill
  events.push({ delay: 2*d,
    data: `id: ${id++}\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt2-think1","tool_name":"Skill","tool_input":{"skill":"dialogue"},"tool_use_id":"tu-skill1","parent_event_id":"${turn1UserId}"}\n\n` });
  events.push({ delay: 3*d,
    data: `id: ${id++}\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt2-think1","tool_name":"Skill","result":"Launching skill: dialogue","is_error":false,"tool_use_id":"tu-skill1"}\n\n` });
  // progress (무시되지만 SSE로 전송됨)
  events.push({ delay: 4*d,
    data: `id: ${id++}\nevent: progress\ndata: {"type":"progress","text":"대사 작업 스킬을 로드하였습니다."}\n\n` });
  // text: response
  events.push({ delay: 5*d,
    data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"mt2-resp1","parent_event_id":"${turn1UserId}"}\n\n` });
  events.push({ delay: 6*d,
    data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"mt2-resp1","text":"대사 작업 스킬을 로드하였습니다. 지시를 기다리겠습니다."}\n\n` });
  events.push({ delay: 7*d,
    data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"mt2-resp1"}\n\n` });
  // result
  events.push({ delay: 8*d,
    data: `id: ${id++}\nevent: result\ndata: {"type":"result","success":true,"output":"대사 작업 스킬을 로드하였습니다.","parent_event_id":"${turn1UserId}"}\n\n` });
  // context_usage (무시)
  events.push({ delay: 9*d,
    data: `id: ${id++}\nevent: context_usage\ndata: {"type":"context_usage","used_tokens":126,"max_tokens":200000,"percent":0.1}\n\n` });
  // COMPLETE — Turn 1 종료 (세션 종료가 아님!)
  events.push({ delay: 10*d,
    data: `id: ${id++}\nevent: complete\ndata: {"type":"complete","result":"대사 작업 스킬을 로드하였습니다. 지시를 기다리겠습니다.","attachments":[],"parent_event_id":"${turn1UserId}"}\n\n` });

  // === Turn 2 (resume) — complete 이후에도 이벤트가 계속되어야 함 ===
  const turn2UserId = id;
  events.push({ delay: 12*d,
    data: `id: ${id++}\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"칼리엘 대사 아이디어를 생각해보자."}\n\n` });
  // thinking
  events.push({ delay: 13*d,
    data: `id: ${id++}\nevent: thinking\ndata: {"type":"thinking","card_id":"mt2-think2","thinking":"Analyzing Act 3 dialogues for Kaliel ideas.","parent_event_id":"${turn2UserId}"}\n\n` });
  // progress
  events.push({ delay: 14*d,
    data: `id: ${id++}\nevent: progress\ndata: {"type":"progress","text":"Rev2 액트 3 대사를 살펴보겠습니다."}\n\n` });
  // text
  events.push({ delay: 15*d,
    data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"mt2-resp2","parent_event_id":"${turn2UserId}"}\n\n` });
  events.push({ delay: 16*d,
    data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"mt2-resp2","text":"Rev2 액트 3 대사 파일들과 칼리엘 캐릭터 정보를 살펴보겠습니다."}\n\n` });
  events.push({ delay: 17*d,
    data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"mt2-resp2"}\n\n` });

  // 5개 tool 호출 (병렬 + 순차 혼합, 실제 세션처럼)
  const tools = [
    { name: "Read", input: '{"file_path":"act3_opening.yaml"}', result: '"dialogues: [...]"' },
    { name: "Bash", input: '{"command":"find . -name act3*"}', result: '"act3_c1_0_opening.yaml"' },
    { name: "Grep", input: '{"pattern":"kl-","path":"act3"}', result: '"kl-KQV0PDHK\\nkl-J8J7EQHA"' },
    { name: "Read", input: '{"file_path":"kl.yaml"}', result: '"칼리엘 (Kaliel)..."' },
    { name: "Bash", input: '{"command":"grep -c kl dlglist"}', result: '"7"' },
  ];

  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const base = 18 + i * 2;
    events.push({ delay: base * d,
      data: `id: ${id++}\nevent: tool_start\ndata: {"type":"tool_start","card_id":"mt2-resp2","tool_name":"${t.name}","tool_input":${t.input},"tool_use_id":"tu-t2-${i}","parent_event_id":"${turn2UserId}"}\n\n` });
    events.push({ delay: (base + 1) * d,
      data: `id: ${id++}\nevent: tool_result\ndata: {"type":"tool_result","card_id":"mt2-resp2","tool_name":"${t.name}","result":${t.result},"is_error":false,"tool_use_id":"tu-t2-${i}"}\n\n` });
  }

  // Turn 2 complete
  events.push({ delay: 30 * d,
    data: `id: ${id++}\nevent: complete\ndata: {"type":"complete","result":"칼리엘 대사 아이디어 10개를 정리했습니다.","attachments":[],"parent_event_id":"${turn2UserId}"}\n\n`,
    end: true });

  return events;
}

const MULTI_TURN_SSE_EVENTS = generateMultiTurnSSEEvents();

// === 서브에이전트 포함 멀티턴 SSE 이벤트 시퀀스 ===

/**
 * Turn 1: user_message → tool(Skill) → text → complete
 * Turn 2: user_message → text → tool(Task) → subagent_start → tool(Grep, parent) → tool_result(Grep) → subagent_stop → tool_result(Task) → text → complete
 */
function generateSubagentSSEEvents(): Array<{ delay: number; data: string; end?: boolean }> {
  const events: Array<{ delay: number; data: string; end?: boolean }> = [];
  let id = 0;
  const d = 50;

  // === Turn 1 ===
  const turn1UserId = id;
  events.push({ delay: 0,
    data: `id: ${id++}\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"스킬을 로드해주세요."}\n\n` });
  events.push({ delay: d,
    data: `id: ${id++}\nevent: tool_start\ndata: {"type":"tool_start","card_id":"sa-t1","tool_name":"Skill","tool_input":{"skill":"dialogue"},"tool_use_id":"tu-skill-1","parent_event_id":"${turn1UserId}"}\n\n` });
  events.push({ delay: 2*d,
    data: `id: ${id++}\nevent: tool_result\ndata: {"type":"tool_result","card_id":"sa-t1","tool_name":"Skill","result":"Skill loaded","is_error":false,"tool_use_id":"tu-skill-1"}\n\n` });
  events.push({ delay: 3*d,
    data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"sa-resp1","parent_event_id":"${turn1UserId}"}\n\n` });
  events.push({ delay: 4*d,
    data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"sa-resp1","text":"스킬을 로드했습니다."}\n\n` });
  events.push({ delay: 5*d,
    data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"sa-resp1"}\n\n` });
  events.push({ delay: 6*d,
    data: `id: ${id++}\nevent: complete\ndata: {"type":"complete","result":"스킬 로드 완료","attachments":[],"parent_event_id":"${turn1UserId}"}\n\n` });

  // === Turn 2 ===
  const turn2UserId = id;
  events.push({ delay: 8*d,
    data: `id: ${id++}\nevent: user_message\ndata: {"type":"user_message","user":"dashboard","text":"코드를 분석해주세요."}\n\n` });
  events.push({ delay: 9*d,
    data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"sa-resp2","parent_event_id":"${turn2UserId}"}\n\n` });
  events.push({ delay: 10*d,
    data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"sa-resp2","text":"코드를 탐색하겠습니다."}\n\n` });
  events.push({ delay: 11*d,
    data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"sa-resp2"}\n\n` });
  // Task tool
  events.push({ delay: 12*d,
    data: `id: ${id++}\nevent: tool_start\ndata: {"type":"tool_start","card_id":"sa-resp2","tool_name":"Task","tool_input":{"subagent_type":"Explore"},"tool_use_id":"tu-task-1","parent_event_id":"${turn2UserId}"}\n\n` });
  // Subagent start
  events.push({ delay: 13*d,
    data: `id: ${id++}\nevent: subagent_start\ndata: {"type":"subagent_start","agent_id":"agent-1","agent_type":"Explore","parent_event_id":"tu-task-1"}\n\n` });
  // Subagent inner tool
  events.push({ delay: 14*d,
    data: `id: ${id++}\nevent: tool_start\ndata: {"type":"tool_start","card_id":"sa-resp2","tool_name":"Grep","tool_input":{"pattern":"TODO"},"tool_use_id":"tu-sub-grep","parent_event_id":"tu-task-1"}\n\n` });
  events.push({ delay: 15*d,
    data: `id: ${id++}\nevent: tool_result\ndata: {"type":"tool_result","card_id":"sa-resp2","tool_name":"Grep","result":"3 matches found","is_error":false,"tool_use_id":"tu-sub-grep","parent_event_id":"tu-task-1"}\n\n` });
  // Subagent stop
  events.push({ delay: 16*d,
    data: `id: ${id++}\nevent: subagent_stop\ndata: {"type":"subagent_stop","agent_id":"agent-1","parent_event_id":"tu-task-1"}\n\n` });
  // Task result
  events.push({ delay: 17*d,
    data: `id: ${id++}\nevent: tool_result\ndata: {"type":"tool_result","card_id":"sa-resp2","tool_name":"Task","result":"코드 탐색 완료","is_error":false,"tool_use_id":"tu-task-1"}\n\n` });
  // Post-subagent text
  events.push({ delay: 18*d,
    data: `id: ${id++}\nevent: text_start\ndata: {"type":"text_start","card_id":"sa-resp3","parent_event_id":"${turn2UserId}"}\n\n` });
  events.push({ delay: 19*d,
    data: `id: ${id++}\nevent: text_delta\ndata: {"type":"text_delta","card_id":"sa-resp3","text":"분석 결과를 정리했습니다."}\n\n` });
  events.push({ delay: 20*d,
    data: `id: ${id++}\nevent: text_end\ndata: {"type":"text_end","card_id":"sa-resp3"}\n\n` });
  events.push({ delay: 22*d,
    data: `id: ${id++}\nevent: complete\ndata: {"type":"complete","result":"분석 완료","attachments":[],"parent_event_id":"${turn2UserId}"}\n\n`,
    end: true });

  return events;
}

const SUBAGENT_SSE_EVENTS = generateSubagentSSEEvents();

// === Mock Dashboard Server Fixture ===

interface MockDashboardServer {
  port: number;
  baseURL: string;
  server: Server;
}

/**
 * 빌드된 클라이언트 + Mock API를 서빙하는 통합 서버.
 * 랜덤 포트 사용으로 포트 충돌을 방지합니다.
 */
/**
 * 세션 목록 fixture — 실제 서버와 동일한 snake_case 형식.
 *
 * 서버의 _task_to_session_info()가 반환하는 필드:
 * agent_session_id, status, prompt, created_at, updated_at
 * (eventCount는 서버가 보내지 않음)
 */
function makeMockSessions() {
  return [
    {
      agent_session_id: "sess-e2e-ui-001",
      status: "running",
      prompt: "src/index.ts 파일을 분석하고 에러 핸들링을 추가해주세요.",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-002",
      status: "completed",
      prompt: "테스트 코드를 작성해주세요.",
      created_at: new Date(Date.now() - 3600000).toISOString(),
      updated_at: new Date(Date.now() - 3500000).toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-003",
      status: "error",
      prompt: "에러 세션 테스트",
      created_at: new Date(Date.now() - 7200000).toISOString(),
      updated_at: new Date(Date.now() - 7100000).toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-multi",
      status: "running",
      prompt: "src/utils.ts에 validateInput 함수를 추가하고 테스트를 실행해주세요.",
      created_at: new Date(Date.now() - 60000).toISOString(),
      updated_at: new Date(Date.now() - 60000).toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-notool",
      status: "completed",
      prompt: "간단히 설명해주세요.",
      created_at: new Date(Date.now() - 120000).toISOString(),
      updated_at: new Date(Date.now() - 110000).toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-large25",
      status: "completed",
      prompt: "대규모 작업을 수행해주세요 (10 단계).",
      created_at: new Date(Date.now() - 180000).toISOString(),
      updated_at: new Date(Date.now() - 170000).toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-large50",
      status: "completed",
      prompt: "대규모 작업을 수행해주세요 (20 단계).",
      created_at: new Date(Date.now() - 240000).toISOString(),
      updated_at: new Date(Date.now() - 230000).toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-multiturn",
      status: "completed",
      prompt: "대사 작업 스킬을 로드하고 다음 지시를 대기.",
      created_at: new Date(Date.now() - 300000).toISOString(),
      updated_at: new Date(Date.now() - 290000).toISOString(),
    },
    {
      agent_session_id: "sess-e2e-ui-subagent",
      status: "completed",
      prompt: "스킬을 로드하고 코드를 분석해주세요.",
      created_at: new Date(Date.now() - 360000).toISOString(),
      updated_at: new Date(Date.now() - 350000).toISOString(),
    },
  ];
}

// === 인증 Mock 상태 (worker-scoped 가변 상태) ===
//
// dashboardServer fixture는 { scope: "worker" }로 선언되어 있어 worker당 서버가 1개 생성됩니다.
// 이 모듈 스코프 변수 mockAuth는 같은 worker 내의 서버 핸들러와 테스트 코드가
// 동일한 모듈 인스턴스를 공유하므로 안전하게 사용할 수 있습니다.
// 주의: fixture scope가 test-scoped로 변경되거나 병렬 worker 수가 1보다 커지면
// 테스트 간 상태 오염이 발생할 수 있으므로 반드시 beforeEach에서 resetMockAuth()를 호출해야 합니다.

interface AuthMockState {
  authEnabled: boolean;
  devModeEnabled: boolean;
  authenticated: boolean;
  user: { email: string; name: string; picture?: string } | null;
}

let mockAuth: AuthMockState = {
  authEnabled: false,
  devModeEnabled: true,
  authenticated: false,
  user: null,
};

/** 인증 비활성(기본) 상태로 초기화 */
function resetMockAuth() {
  mockAuth = { authEnabled: false, devModeEnabled: true, authenticated: false, user: null };
}

/** 인증 활성 시나리오 설정 */
function configureMockAuth(opts: {
  authEnabled: boolean;
  authenticated: boolean;
  user?: AuthMockState["user"];
  devModeEnabled?: boolean;
}) {
  mockAuth = {
    authEnabled: opts.authEnabled,
    devModeEnabled: opts.devModeEnabled ?? true,
    authenticated: opts.authenticated,
    user: opts.user ?? null,
  };
}

const test = base.extend<{ dashboardServer: MockDashboardServer }, { dashboardServer: MockDashboardServer }>({
  dashboardServer: [async ({}, use) => {
    const app = express();
    // JSON 파싱 미들웨어를 모든 라우트보다 먼저 등록 (req.body 파싱 보장)
    app.use(express.json());

    // --- Mock: 세션 목록 — 실제 서버와 동일한 snake_case 형식 ---
    app.get("/api/sessions", (_req, res) => {
      res.json({ sessions: makeMockSessions() });
    });

    // --- Mock: Health check ---
    app.get("/api/health", (_req, res) => {
      res.json({ status: "ok", service: "soul-dashboard" });
    });

    // --- Mock: Config ---
    app.get("/api/config/settings", (_req, res) => {
      res.json({ serendipityAvailable: false, categories: [] });
    });
    // --- Mock: 인증 엔드포인트 (가변 상태 기반) ---
    app.get("/api/auth/config", (_req, res) => {
      res.json({ authEnabled: mockAuth.authEnabled, devModeEnabled: mockAuth.devModeEnabled });
    });
    app.get("/api/auth/status", (_req, res) => {
      res.json({ authenticated: mockAuth.authenticated, user: mockAuth.user });
    });
    app.post("/api/auth/dev-login", (req, res) => {
      const { email, name } = req.body as { email: string; name?: string };
      mockAuth.authenticated = true;
      mockAuth.user = { email, name: name ?? "Dev User" };
      res.cookie("soul_dashboard_auth", "test-jwt", { httpOnly: true });
      res.json({ success: true });
    });
    app.post("/api/auth/logout", (_req, res) => {
      mockAuth.authenticated = false;
      mockAuth.user = null;
      res.clearCookie("soul_dashboard_auth");
      res.json({ success: true });
    });

    // --- Mock: 세션 생성/재개 — CreateSessionResponse 형식 ---
    // Create & Resume 모두 POST /api/sessions 단일 엔드포인트 사용.
    // Resume 시 body.agentSessionId가 전달되면 재사용, 아니면 새 ID.
    app.use(express.json());
    app.post("/api/sessions", (req, res) => {
      const response: CreateSessionResponse = {
        agentSessionId: req.body.agentSessionId ?? "sess-e2e-new-001",
        status: "running",
      };
      res.status(201).json(response);
    });

    // --- Mock: 세션 개입 — InterveneResponse 형식 ---
    app.post("/api/sessions/:id/intervene", (_req, res) => {
      const response: InterveneResponse = {
        queue_position: 1,
      };
      res.json(response);
    });
    app.post("/api/sessions/:id/message", (_req, res) => {
      const response: InterveneResponse = {
        queue_position: 1,
      };
      res.json(response);
    });

    // --- Mock: 세션 목록 SSE 스트림 (SSE 모드에서 사용) ---
    app.get("/api/sessions/stream", (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const sessions = makeMockSessions();
      const data = JSON.stringify({ type: "session_list", sessions });
      res.write(`event: session_list\ndata: ${data}\n\n`);

      // 연결 유지 (클라이언트가 끊을 때까지)
      _req.on("close", () => {
        res.end();
      });
    });

    // 세션별 SSE 요청 횟수 추적 (캐시 리플레이 시뮬레이션)
    const sessionRequestCount = new Map<string, number>();

    // --- Mock: SSE 이벤트 스트림 ---
    app.get("/api/sessions/:id/events", (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const timers: NodeJS.Timeout[] = [];

      // 클라이언트 연결 종료 시 타이머 정리 (ERR_STREAM_DESTROYED 방지)
      res.on("close", () => {
        timers.forEach(clearTimeout);
      });

      // 연결 확인
      res.write("event: connected\ndata: {}\n\n");

      // history_sync 이벤트: 히스토리 리플레이 완료 → 라이브 이벤트 시작
      // ctx.historySynced = true로 전환되어야 deriveSessionStatus()가 세션 상태를 갱신함
      res.write(
        'event: history_sync\ndata: {"type":"history_sync","last_event_id":0,"is_live":true,"status":"running"}\n\n',
      );

      // 세션 ID에 따라 이벤트 시퀀스 선택
      const sessionId = req.params.id;

      // 요청 횟수 추적: 2회차 이후는 캐시 리플레이 (지연 없음)
      const count = (sessionRequestCount.get(sessionId) ?? 0) + 1;
      sessionRequestCount.set(sessionId, count);
      const isCacheReplay = count >= 2;
      let events: Array<{ delay: number; data: string; end?: boolean }>;
      if (sessionId.includes("large50")) {
        events = LARGE_50_SSE_EVENTS;
      } else if (sessionId.includes("large25")) {
        events = LARGE_25_SSE_EVENTS;
      } else if (sessionId.includes("notool")) {
        events = NO_TOOL_SSE_EVENTS;
      } else if (sessionId.includes("subagent")) {
        events = SUBAGENT_SSE_EVENTS;
      } else if (sessionId.includes("multiturn")) {
        events = MULTI_TURN_SSE_EVENTS;
      } else if (sessionId.includes("multi")) {
        events = MULTI_TOOL_SSE_EVENTS;
      } else {
        events = SSE_EVENTS;
      }

      // SSE 이벤트 스케줄링 (캐시 리플레이 시 지연 없음)
      for (const event of events) {
        const effectiveDelay = isCacheReplay ? 0 : event.delay;
        timers.push(
          setTimeout(() => {
            if (!res.writableEnded) {
              res.write(event.data);
              if (event.end) {
                res.end();
              }
            }
          }, effectiveDelay),
        );
      }
    });

    // --- 빌드된 클라이언트 정적 파일 서빙 ---
    const clientDistDir = path.resolve(__dirname, "../dist/client");
    app.use(express.static(clientDistDir));

    // SPA fallback: API 외 모든 GET 요청에 index.html 반환
    app.get("/{*splat}", (_req, res) => {
      res.sendFile(path.join(clientDistDir, "index.html"));
    });

    // 랜덤 포트에서 서버 시작
    const server = createServer(app);
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(0, () => {
        server.removeListener("error", onError);
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        resolve(p);
      });
    });

    const baseURL = `http://localhost:${port}`;

    await use({ port, baseURL, server });

    // 정리: SSE 등 열린 연결을 강제 종료한 후 서버 종료 (타임아웃 가드 포함)
    server.closeAllConnections();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }, { scope: "worker" }],
});

// === Screenshot 디렉토리 ===

const SCREENSHOT_DIR = path.join(__dirname, "screenshots");

// === Helpers ===

/** React Flow 뷰포트에서 현재 zoom 값을 추출 */
async function getReactFlowZoom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const rf = document.querySelector(".react-flow");
    if (!rf) return null;
    const transform = rf
      .querySelector(".react-flow__viewport")
      ?.getAttribute("style");
    if (!transform) return null;
    const match = transform.match(/scale\(([^)]+)\)/);
    return match ? parseFloat(match[1]) : null;
  });
}

/** 페이지 내 React Flow 노드들의 AABB 겹침 검사 */
async function checkNodeOverlaps(page: Page): Promise<Array<{ a: string; b: string }>> {
  const boxes = await page.evaluate(() => {
    const nodes = document.querySelectorAll(".react-flow__node");
    return Array.from(nodes).map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        id: node.getAttribute("data-id") ?? "unknown",
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
      };
    });
  });

  const margin = 2;
  const overlaps: Array<{ a: string; b: string }> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX =
        a.x + margin < b.x + b.w - margin &&
        a.x + a.w - margin > b.x + margin;
      const overlapY =
        a.y + margin < b.y + b.h - margin &&
        a.y + a.h - margin > b.y + margin;
      if (overlapX && overlapY) {
        overlaps.push({ a: a.id, b: b.id });
      }
    }
  }
  return overlaps;
}

/** 페이지 내 노드 타입별 개수를 캡처 */
async function captureNodeSnapshot(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const types = ["user-node", "thinking-node", "tool-call-node", "system-node"];
    const snapshot: Record<string, number> = {};
    for (const type of types) {
      snapshot[type] = document.querySelectorAll(`[data-testid="${type}"]`).length;
    }
    snapshot["total"] = document.querySelectorAll(".react-flow__node").length;
    return snapshot;
  });
}

/** 대시보드에 접속하고 세션을 선택하는 공통 설정 */
async function navigateAndSelectSession(
  page: Page,
  baseURL: string,
  sessionKey = "sess-e2e-ui-001",
) {
  await page.goto(baseURL);
  await expect(
    page.locator('[data-testid^="session-item-"]'),
  ).toHaveCount(9, { timeout: 10_000 });
  await page
    .locator(`[data-testid="session-item-${sessionKey}"]`)
    .click();
}

// === Tests ===

test.describe("Soul Dashboard 브라우저 UI", () => {
  test.beforeAll(async () => {
    // 스크린샷 디렉토리 생성
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  });

  test("1. 대시보드 초기 렌더링 + 세션 목록 로드", async ({
    page,
    dashboardServer,
  }) => {
    // Mock 서버로 이동
    await page.goto(dashboardServer.baseURL);

    // 대시보드 레이아웃 확인
    const layout = page.locator('[data-testid="dashboard-layout"]');
    await expect(layout).toBeVisible({ timeout: 15_000 });

    // 헤더에 "Soul Dashboard" 텍스트 확인
    await expect(page.locator("header")).toContainText("Soul Dashboard");

    // 세션 패널 확인
    const sessionPanel = page.locator('[data-testid="session-panel"]');
    await expect(sessionPanel).toBeVisible();

    // 스크린샷: 초기 로딩 상태
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-initial-loading.png`,
      fullPage: true,
    });

    // 세션 목록 로드 대기
    const sessionList = page.locator('[data-testid="session-list"]');
    await expect(sessionList).toBeVisible();

    // 세션 항목이 렌더링될 때까지 대기 (mock에서 3개 반환)
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // 세션 상태 뱃지 확인
    const statusBadges = page.locator('[data-testid="session-status-badge"]');
    await expect(statusBadges).toHaveCount(9);

    // 그래프 패널 확인 (세션 미선택 → "Select a session" 안내)
    const graphPanel = page.locator('[data-testid="graph-panel"]');
    await expect(graphPanel).toBeVisible();

    // 디테일 패널 확인 (노드 미선택 → "Select a node" 안내)
    const detailPanel = page.locator('[data-testid="detail-panel"]');
    await expect(detailPanel).toBeVisible();

    // 스크린샷: 세션 목록 로드 완료
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-sessions-loaded.png`,
      fullPage: true,
    });
  });

  test("2. SSE 이벤트 → React Flow 노드 그래프 렌더링", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // SSE 연결 + 이벤트 수신 대기
    // Thinking 노드가 나타날 때까지 대기 (text_start 이벤트 이후)
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // 스크린샷: 첫 thinking 노드 렌더링
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-first-thinking-node.png`,
      fullPage: true,
    });

    // Tool Call 노드가 나타날 때까지 대기 (tool_start 이벤트 이후)
    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // Complete 이벤트 도착 대기: Session Started(root) + Complete = system-node 2개
    const completeNodes = page.locator('[data-testid="system-node"]');
    await expect(completeNodes).toHaveCount(2, { timeout: 10_000 });

    // React Flow 캔버스에 노드와 엣지가 렌더링되었는지 확인
    const reactFlowNodes = page.locator(".react-flow__node");
    const nodeCount = await reactFlowNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(5); // root + user + thinking + tool + complete

    // 스크린샷: 전체 노드 그래프 렌더링
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-node-graph-rendered.png`,
      fullPage: true,
    });
  });

  test("3. 노드 클릭 → Detail 패널 표시", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // 노드들이 렌더링될 때까지 대기
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // Tool 노드가 렌더링될 때까지 대기
    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // Thinking 노드 클릭
    await thinkingNodes.first().click();

    // Detail 패널에 내용이 표시되는지 확인
    const detailView = page.locator('[data-testid="detail-view"]');
    await expect(detailView).toBeVisible();

    // Thinking 카드 상세에서 "Thinking" 헤더 확인
    // (ThinkingDetail 컴포넌트가 "💭 Thinking" 헤더를 렌더링)
    await expect(detailView.getByText("Thinking")).toBeVisible();

    // 스크린샷: Thinking 노드 선택 → Detail 패널
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-thinking-detail.png`,
      fullPage: true,
    });

    // Tool Call 노드 클릭
    await toolNodes.first().click();

    // Detail 패널이 Tool 상세로 업데이트되는지 확인
    // Tool 상세에는 도구 이름("Read")이 표시되어야 함
    await expect(detailView).toContainText("Read", { timeout: 5_000 });

    // 스크린샷: Tool 노드 선택 → Detail 패널
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-tool-detail.png`,
      fullPage: true,
    });
  });

  test("4. Complete 상태 + 레이아웃 검증", async ({ page, dashboardServer }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // Complete 이벤트까지 대기: Session Started(root) + Complete = system-node 2개
    const completeNodes = page.locator('[data-testid="system-node"]');
    await expect(completeNodes).toHaveCount(2, { timeout: 10_000 });

    // 전체 노드 그래프가 렌더링된 상태 확인
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // user 노드 존재 확인 (user_message 이벤트 추가됨)
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes.first()).toBeVisible({ timeout: 10_000 });

    // thinking + tool 노드가 모두 존재하는지 확인
    const thinkingCount = await thinkingNodes.count();
    expect(thinkingCount).toBeGreaterThanOrEqual(1);

    // 레이아웃 검증: thinking 노드들이 세로로 정렬되고, tool 노드가 오른쪽에 배치
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(5); // root + user + thinking + tool + complete

    // 스크린샷: Complete 상태의 전체 대시보드
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/07-complete-state.png`,
      fullPage: true,
    });
  });

  test("5. 멀티 Tool 호출 시나리오 (Read → Write → Bash)", async ({
    page,
    dashboardServer,
  }) => {
    // 멀티 Tool 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete 이벤트까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });

    // 3개의 Tool Call 노드 확인 (Read, Write, Bash)
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolCallNodes).toHaveCount(3, { timeout: 10_000 });

    // System 노드 확인: Session Started(root) + Complete = 2
    const completeNodes = page.locator('[data-testid="system-node"]');
    await expect(completeNodes).toHaveCount(2, { timeout: 10_000 });

    // User 노드 확인
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes).toHaveCount(1, { timeout: 10_000 });

    // Thinking 노드 확인 (mt-t1, mt-t2 → 2개)
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes).toHaveCount(2, { timeout: 10_000 });

    // 전체 노드 수: user(1) + thinking(2) + tool_call(3) + system(1, complete) = 7
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(7);

    // 레이아웃 정렬 검증: Tool Call 노드들이 세로 체이닝 (같은 X 좌표)
    const toolCallBoxes = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        toolCallNodes.nth(i).boundingBox(),
      ),
    );

    // BoundingBox가 null이 아닌지 명시적 확인
    for (const box of toolCallBoxes) {
      expect(box).not.toBeNull();
    }

    // 모든 Tool Call 노드의 X 좌표가 동일한지 확인 (±2px 허용)
    const xPositions = toolCallBoxes.map((b) => b!.x);
    expect(Math.abs(xPositions[0] - xPositions[1])).toBeLessThan(3);
    expect(Math.abs(xPositions[1] - xPositions[2])).toBeLessThan(3);

    // Tool Call 노드들이 위에서 아래로 정렬 (Y 좌표 증가)
    expect(toolCallBoxes[0]!.y).toBeLessThan(toolCallBoxes[1]!.y);
    expect(toolCallBoxes[1]!.y).toBeLessThan(toolCallBoxes[2]!.y);

    // 노드 크기 일관성 검증: 모든 Tool Call 노드의 너비가 동일 (viewport zoom 적용)
    const widths = toolCallBoxes.map((b) => b!.width);
    expect(Math.abs(widths[0] - widths[1])).toBeLessThan(2);
    expect(Math.abs(widths[1] - widths[2])).toBeLessThan(2);

    // 스크린샷: 멀티 Tool 전체 그래프
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/08-multi-tool-graph.png`,
      fullPage: true,
    });

    // 각 Tool 노드에 도구 이름이 정확히 표시되는지 확인
    for (const toolName of ["Read", "Write", "Bash"]) {
      await expect(
        toolCallNodes.filter({ hasText: toolName }),
      ).toHaveCount(1);
    }

    // 스크린샷: 멀티 Tool 전체 그래프 (상세)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/09-multi-tool-detail.png`,
      fullPage: true,
    });
  });

  test("6. 뷰포트 줌 불변 검증 (세션 전환 후 스트리밍 중 zoom 변경 없음)", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(page, dashboardServer.baseURL);

    // Thinking 노드가 나타날 때까지 대기 (첫 로드 → zoom 설정 1회 발생)
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // 첫 로드 후 viewport 안정화 대기 (300ms animation + 여유)
    await page.waitForTimeout(500);

    // 현재 zoom 값 캡처 (첫 로드 후 설정된 값)
    const initialZoom = await getReactFlowZoom(page);

    expect(initialZoom).not.toBeNull();
    expect(initialZoom).toBeGreaterThan(0);

    // Tool Call 노드가 렌더링될 때까지 대기 (스트리밍 중 새 노드 추가)
    const toolNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolNodes.first()).toBeVisible({ timeout: 10_000 });

    // Complete 이벤트 도착 대기: Session Started(root) + Complete = system-node 2개
    const completeNodes = page.locator('[data-testid="system-node"]');
    await expect(completeNodes).toHaveCount(2, { timeout: 10_000 });

    // 스트리밍 후 viewport 안정화 대기
    await page.waitForTimeout(500);

    // 스트리밍 후 zoom 값 확인 — 변경되지 않아야 함
    const afterStreamZoom = await getReactFlowZoom(page);

    expect(afterStreamZoom).not.toBeNull();

    // 줌 불변 검증: 스트리밍 중 zoom이 크게 변경되지 않아야 함 (±0.05 허용)
    // 0.05 허용: 첫 로드 시 그래프 바운딩 박스가 노드 추가로 미세하게 변할 수 있어
    // 초기 줌 계산에 소수점 이하 차이가 발생할 수 있음 (fitView 대체 → 수동 계산 특성)
    expect(Math.abs(afterStreamZoom! - initialZoom!)).toBeLessThan(0.05);

    // 스크린샷: 줌 불변 검증 후 상태
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/10-zoom-invariant.png`,
      fullPage: true,
    });
  });

  test("7. 노드 겹침 없음 검증 (바운딩 박스 교차 검사)", async ({
    page,
    dashboardServer,
  }) => {
    // 멀티 Tool 세션 선택 (더 많은 노드)
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete 이벤트까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });

    // viewport 안정화 대기
    await page.waitForTimeout(500);

    // 노드가 충분히 렌더링되었는지 확인
    // MULTI_TOOL: root(1) + user(1) + thinking(2) + tool(3) + complete(1) = 8
    const nodeCount = await page.locator(".react-flow__node").count();
    expect(nodeCount).toBeGreaterThanOrEqual(7);

    // AABB 겹침 검사: 어떤 두 노드도 겹치면 안 됨
    const overlaps = await checkNodeOverlaps(page);
    expect(
      overlaps,
      `노드 겹침 발견: ${JSON.stringify(overlaps)}`,
    ).toHaveLength(0);

    // 스크린샷: 겹침 없음 검증 후 상태
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/11-no-overlap.png`,
      fullPage: true,
    });
  });

  test("8. Tool call 없는 세션: 노드 세로 배치 검증 (Bug #10 regression)", async ({
    page,
    dashboardServer,
  }) => {
    // tool 없는 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-notool",
    );

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 10_000 });

    // viewport 안정화
    await page.waitForTimeout(500);

    // System 노드 확인: Session Started(root) + Complete = 2
    const completeNodes = page.locator('[data-testid="system-node"]');
    await expect(completeNodes).toHaveCount(2, { timeout: 10_000 });

    // User 노드 확인
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes).toHaveCount(1, { timeout: 10_000 });

    // Tool 노드 없음
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolCallNodes).toHaveCount(0);

    // 전체 노드 수: user(1) + thinking(1) + system(1, complete) = 3 이상
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(3);

    // AABB 겹침 검사
    const overlaps = await checkNodeOverlaps(page);
    expect(overlaps, `노드 겹침: ${JSON.stringify(overlaps)}`).toHaveLength(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/12-no-tool-session.png`,
      fullPage: true,
    });
  });

  test("9. 25+ 노드 세션: EXECUTION FLOW 정상 렌더링 (Bug #10/#14 regression)", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-large25",
    );

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 30_000 });

    await page.waitForTimeout(500);

    // 노드가 렌더링되었는지 확인
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(20);

    // 노드가 뷰포트 내에 표시되는지 확인 (하나 이상)
    const visibleNodes = await page.evaluate(() => {
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const nodes = document.querySelectorAll(".react-flow__node");
      let visible = 0;
      nodes.forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.x + rect.width > 0 && rect.x < vpW && rect.y + rect.height > 0 && rect.y < vpH) {
          visible++;
        }
      });
      return visible;
    });
    expect(visibleNodes).toBeGreaterThan(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/13-large25-session.png`,
      fullPage: true,
    });
  });

  test("10. 50+ 노드 세션: EXECUTION FLOW 비어있지 않음 (Bug #14 regression)", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-large50",
    );

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 60_000 });

    await page.waitForTimeout(500);

    // 노드가 렌더링되었는지 확인
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(40);

    // 뷰포트 내에 하나 이상의 노드가 보여야 함 (14번 버그: 비어있으면 안됨)
    const visibleNodes = await page.evaluate(() => {
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      const nodes = document.querySelectorAll(".react-flow__node");
      let visible = 0;
      nodes.forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.x + rect.width > 0 && rect.x < vpW && rect.y + rect.height > 0 && rect.y < vpH) {
          visible++;
        }
      });
      return visible;
    });
    expect(visibleNodes).toBeGreaterThan(0);

    // 모든 노드의 바운딩 박스가 유한한 범위 내에 있는지 확인
    const allNodeBoxes = await page.evaluate(() => {
      const nodes = document.querySelectorAll(".react-flow__node");
      return Array.from(nodes).map((node) => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
      });
    });

    // 0 크기 노드가 없어야 함 (렌더링 실패 표지)
    const zeroSizeNodes = allNodeBoxes.filter((b) => b.w === 0 || b.h === 0);
    expect(zeroSizeNodes).toHaveLength(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/14-large50-session.png`,
      fullPage: true,
    });
  });

  test("11. 세션 생성 → 응답 계약 검증 → SSE 구독 → 그래프 렌더링 (핵심 E2E)", async ({
    page,
    dashboardServer,
  }) => {
    // SSE 구독 URL 감시
    const sseUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/events")) {
        sseUrls.push(req.url());
      }
    });

    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 대기
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // 초기 상태: 세션 미선택 → PromptComposer 표시됨
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 세션 선택하여 PromptComposer 닫기 (+ New 활성화)
    await page.locator('[data-testid="session-item-sess-e2e-ui-001"]').click();
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // "+ New" 버튼 클릭 → PromptComposer 다시 표시
    await page.locator('[data-testid="new-session-button"]').click();
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await expect(composer).toContainText("New Conversation");

    // 스크린샷: PromptComposer 표시
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/15-prompt-composer-new.png`,
      fullPage: true,
    });

    // 프롬프트 입력
    const textarea = composer.locator("textarea");
    await textarea.fill("새 세션을 시작합니다. 테스트 프롬프트입니다.");

    // Submit 버튼 활성화 확인
    const submitBtn = page.locator('[data-testid="compose-submit"]');
    await expect(submitBtn).toBeEnabled();

    // waitForResponse 설정 후 Submit 클릭 — race condition 방지
    const createResponsePromise = page.waitForResponse(
      (resp) =>
        resp.request().method() === "POST" &&
        resp.url().includes("/api/sessions") &&
        !resp.url().includes("/intervene") &&
        !resp.url().includes("/events"),
    );
    await submitBtn.click();
    const rawResponse = await createResponsePromise;
    const createResponse = await rawResponse.json();

    // PromptComposer 사라짐 확인 (세션 생성 성공 후)
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // [계약 검증 1] CreateSessionResponse 형식 — agentSessionId 필수, 레거시 필드 없음
    expect(createResponse).toHaveProperty("agentSessionId");
    expect(typeof createResponse.agentSessionId).toBe("string");
    expect(createResponse.agentSessionId).toBeTruthy();
    expect(createResponse).toHaveProperty("status", "running");

    // 레거시 필드가 응답에 없어야 함 (이 버그를 방지!)
    expect(createResponse).not.toHaveProperty("sessionKey");
    expect(createResponse).not.toHaveProperty("clientId");
    expect(createResponse).not.toHaveProperty("requestId");

    // SSE 구독이 시작되어 노드가 렌더링되기 시작
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // [계약 검증 2] SSE 구독 URL이 응답의 agentSessionId를 사용하는지 확인
    const expectedSessionId = createResponse.agentSessionId as string;
    const newSessionSSE = sseUrls.filter((url) => url.includes(expectedSessionId));
    expect(
      newSessionSSE.length,
      `SSE 구독이 agentSessionId(${expectedSessionId})로 시작되어야 함. 실제 SSE URLs: ${sseUrls.join(", ")}`,
    ).toBeGreaterThanOrEqual(1);

    // 스크린샷: 세션 생성 후 그래프 표시
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/16-session-created.png`,
      fullPage: true,
    });
  });

  test("12. 완료 세션 ChatInput Resume → Intervene API 계약 검증", async ({
    page,
    dashboardServer,
  }) => {
    // API 요청 감시: intervene 호출 캡처
    let interveneRequest: { url: string; body: Record<string, unknown> } | null = null;

    page.on("request", async (req) => {
      if (req.method() === "POST" && req.url().includes("/intervene")) {
        interveneRequest = {
          url: req.url(),
          body: JSON.parse(req.postData() ?? "{}"),
        };
      }
    });

    // 완료된 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-002",
    );

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 10_000 });

    // ChatInput이 "New Chat" 모드로 표시
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
    await expect(chatInput).toContainText("New Chat");

    // "Resume" 버튼 (send-button) 표시 확인
    const sendBtn = page.locator('[data-testid="send-button"]');
    await expect(sendBtn).toContainText("Resume");

    // 스크린샷: 완료 세션 ChatInput
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/17-completed-session-chatinput.png`,
      fullPage: true,
    });

    // 프롬프트 입력 + Resume 클릭
    const textarea = chatInput.locator("textarea");
    await textarea.fill("이어서 작업해주세요.");
    await sendBtn.click();

    // [계약 검증] Intervene API 호출이 올바른 세션 ID로 이루어졌는지 확인
    await page.waitForTimeout(500);
    expect(interveneRequest).not.toBeNull();
    expect(interveneRequest!.url).toContain("sess-e2e-ui-002");
    expect(interveneRequest!.body).toHaveProperty("text", "이어서 작업해주세요.");

    // 전송 후 textarea 비워짐 확인
    await expect(textarea).toHaveValue("", { timeout: 5_000 });

    // 스크린샷: Resume 전송 후
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/18-resume-sent.png`,
      fullPage: true,
    });
  });

  test("13. 완료된 세션 ChatInput — New Chat 모드 + Resume 버튼 표시", async ({
    page,
    dashboardServer,
  }) => {
    // 완료된 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-002",
    );

    // Complete 이벤트까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 10_000 });

    // ChatInput이 "New Chat" 모드로 표시
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
    await expect(chatInput).toContainText("New Chat");

    // "Resume" 버튼(send-button) 표시 — 완료 세션에서 버튼 텍스트가 "Resume"
    const sendBtn = page.locator('[data-testid="send-button"]');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toContainText("Resume");

    // textarea 표시 (완료 상태에서도 입력 가능)
    await expect(chatInput.locator("textarea")).toBeVisible();

    // placeholder가 완료 모드에 맞게 표시
    await expect(chatInput.locator("textarea")).toHaveAttribute(
      "placeholder",
      "Continue the conversation...",
    );

    // 빈 상태에서 Resume 버튼 비활성화
    await expect(sendBtn).toBeDisabled();

    // 텍스트 입력 → Resume 버튼 활성화
    await chatInput.locator("textarea").fill("이어서 설명해주세요.");
    await expect(sendBtn).toBeEnabled();

    // 스크린샷: 완료된 세션 ChatInput
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/19-completed-session-chatinput.png`,
      fullPage: true,
    });
  });

  test("14. 메시지 전송 — Intervention 또는 Resume 모드에서 전송 가능", async ({
    page,
    dashboardServer,
  }) => {
    // Running 세션 선택
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-001",
    );

    // SSE 스트리밍 시작 대기
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // ChatInput 표시 대기 (캐시 리플레이 시 세션이 즉시 완료될 수 있음)
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });

    // Intervention 또는 New Chat 모드 (캐시 리플레이 시 완료 상태)
    const chatText = await chatInput.textContent();
    expect(
      chatText?.includes("Intervention") || chatText?.includes("New Chat"),
      `ChatInput should show Intervention or New Chat mode, got: ${chatText}`,
    ).toBe(true);

    // textarea와 Send 버튼 표시
    const textarea = chatInput.locator("textarea");
    await expect(textarea).toBeVisible();
    const sendBtn = page.locator('[data-testid="send-button"]');
    await expect(sendBtn).toBeVisible();

    // 메시지 입력
    await textarea.fill("이 부분을 수정해주세요.");

    // Send 버튼 활성화 확인
    await expect(sendBtn).toBeEnabled();

    // Send 클릭
    await sendBtn.click();

    // 전송 후 textarea 비워짐 확인
    await expect(textarea).toHaveValue("", { timeout: 5_000 });

    // 스크린샷: 메시지 전송 후
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/21-message-sent.png`,
      fullPage: true,
    });
  });

  test("15. 세션 목록 SSE 스트림 검증 — /api/sessions/stream 연결 + UI 렌더링", async ({
    page,
    dashboardServer,
  }) => {
    // SSE 모드: /api/sessions/stream 요청이 발생하는지 감시
    const sseRequestPromise = page.waitForRequest(
      (req) =>
        req.method() === "GET" &&
        req.url().includes("/api/sessions/stream"),
    );

    await page.goto(dashboardServer.baseURL);

    // SSE 요청이 발생했는지 확인 (SSE 모드가 기본 활성)
    const sseRequest = await sseRequestPromise;
    expect(sseRequest.url()).toContain("/api/sessions/stream");

    // SSE를 통해 세션 목록이 UI에 로드됨
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // 각 세션 항목에 agentSessionId 기반 data-testid가 있는지 확인
    for (const sessionId of [
      "sess-e2e-ui-001",
      "sess-e2e-ui-002",
      "sess-e2e-ui-003",
      "sess-e2e-ui-multi",
      "sess-e2e-ui-notool",
      "sess-e2e-ui-large25",
      "sess-e2e-ui-large50",
      "sess-e2e-ui-multiturn",
      "sess-e2e-ui-subagent",
    ]) {
      await expect(
        page.locator(`[data-testid="session-item-${sessionId}"]`),
      ).toBeVisible();
    }

    // 상태 뱃지가 8개 표시됨
    const statusBadges = page.locator('[data-testid="session-status-badge"]');
    await expect(statusBadges).toHaveCount(9);
  });

  test("16. 세션 전환 시 이전 그래프 초기화 검증", async ({
    page,
    dashboardServer,
  }) => {
    // 첫 번째 세션 선택 (멀티 Tool)
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(300);

    // 멀티 Tool 세션의 노드 수 확인
    const multiToolNodeCount = await page.locator(".react-flow__node").count();
    expect(multiToolNodeCount).toBeGreaterThanOrEqual(7);

    // 3개의 Tool Call 노드 확인 (멀티 Tool 세션 고유)
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolCallNodes).toHaveCount(3, { timeout: 5_000 });

    // 다른 세션으로 전환 (Tool 없는 세션)
    await page
      .locator('[data-testid="session-item-sess-e2e-ui-notool"]')
      .click();

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 10_000 });
    await page.waitForTimeout(300);

    // 이전 세션의 3개 Tool Call 노드가 사라졌는지 확인
    // (Tool 없는 세션에서는 tool-call-node가 0개)
    await expect(toolCallNodes).toHaveCount(0, { timeout: 5_000 });

    // 현재 세션의 노드가 정상 렌더링되는지 확인
    // Session Started(root) + Complete = 2
    const completeNodes = page.locator('[data-testid="system-node"]');
    await expect(completeNodes).toHaveCount(2, { timeout: 5_000 });

    // 스크린샷: 세션 전환 후 그래프
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/22-session-switch-graph-reset.png`,
      fullPage: true,
    });
  });

  test("17. 세션 생성 후 SSE 이벤트가 올바른 세션으로 라우팅되는지 검증", async ({
    page,
    dashboardServer,
  }) => {
    // SSE 구독 URL 캡처
    const sseUrls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/events")) {
        sseUrls.push(req.url());
      }
    });

    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 대기
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // 초기 상태: PromptComposer 표시, "+New" 비활성
    // 먼저 세션을 선택하여 Composer를 닫은 후 "+New" 활성화
    await page.locator('[data-testid="session-item-sess-e2e-ui-001"]').click();
    await expect(
      page.locator('[data-testid="prompt-composer"]'),
    ).not.toBeVisible({ timeout: 5_000 });

    // "+ New" → PromptComposer → Submit
    await page.locator('[data-testid="new-session-button"]').click();
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });
    await composer.locator("textarea").fill("SSE 라우팅 테스트");
    await page.locator('[data-testid="compose-submit"]').click();
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // SSE 이벤트가 도착하여 노드가 렌더링되기 시작
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });

    // SSE 구독이 새 세션 ID(sess-e2e-new-001)로 이루어졌는지 확인
    const newSessionSSE = sseUrls.filter((url) =>
      url.includes("sess-e2e-new-001"),
    );
    expect(
      newSessionSSE.length,
      `SSE가 sess-e2e-new-001에 구독되어야 함`,
    ).toBeGreaterThanOrEqual(1);

    // Complete 이벤트까지 수신 완료 → 전체 그래프가 렌더링됨
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(3); // user + thinking + complete

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/23-sse-routing-verified.png`,
      fullPage: true,
    });
  });

  test("18. 세션 생성 후 세션 리스트에 즉시 표시 (낙관적 업데이트)", async ({
    page,
    dashboardServer,
  }) => {
    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 대기 (7개)
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // 세션 선택하여 PromptComposer 닫기
    await page.locator('[data-testid="session-item-sess-e2e-ui-001"]').click();
    await expect(
      page.locator('[data-testid="prompt-composer"]'),
    ).not.toBeVisible({ timeout: 5_000 });

    // "+ New" 버튼 클릭 → PromptComposer 표시
    await page.locator('[data-testid="new-session-button"]').click();
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 프롬프트 입력 + Submit
    await composer.locator("textarea").fill("낙관적 업데이트 테스트 세션");
    await page.locator('[data-testid="compose-submit"]').click();

    // PromptComposer 사라짐 확인
    await expect(composer).not.toBeVisible({ timeout: 5_000 });

    // 검증: 세션 리스트에 즉시 10개 표시 (폴링 없이 낙관적 추가)
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(10, { timeout: 5_000 });

    // 검증: 새 세션(sess-e2e-new-001)이 목록에 표시
    await expect(
      page.locator('[data-testid="session-item-sess-e2e-new-001"]'),
    ).toBeVisible({ timeout: 5_000 });

    // 스크린샷: 낙관적 세션 추가 후
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/24-optimistic-session-added.png`,
      fullPage: true,
    });
  });

  test("19. Complete 이벤트 후 ChatInput이 New Chat 모드로 전환", async ({
    page,
    dashboardServer,
  }) => {
    // Running 세션 선택 (sess-e2e-ui-001)
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-001",
    );

    // SSE 스트리밍 시작 대기
    const thinkingNodes = page.locator('[data-testid="thinking-node"]');
    await expect(thinkingNodes.first()).toBeVisible({ timeout: 10_000 });

    // ChatInput이 "Intervention" 모드로 표시
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
    await expect(chatInput).toContainText("Intervention");

    // Complete 이벤트 도착 대기: Session Started(root) + Complete = system-node 2개
    const completeNodes = page.locator('[data-testid="system-node"]');
    await expect(completeNodes).toHaveCount(2, { timeout: 10_000 });

    // 검증: ChatInput이 "New Chat" 모드로 전환 (complete 후 sessions 상태 갱신)
    await expect(chatInput).toContainText("New Chat", { timeout: 5_000 });

    // 검증: "Resume" 버튼이 표시
    const sendBtn = page.locator('[data-testid="send-button"]');
    await expect(sendBtn).toContainText("Resume");

    // 스크린샷: Complete 후 ChatInput 전환
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/25-complete-chatinput-transition.png`,
      fullPage: true,
    });
  });

  test("20. PromptComposer 입력 검증 — 빈 프롬프트 방지 + Submit 활성화", async ({
    page,
    dashboardServer,
  }) => {
    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 대기
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // 초기 상태: 세션 미선택 → PromptComposer 표시됨
    const composer = page.locator('[data-testid="prompt-composer"]');
    await expect(composer).toBeVisible({ timeout: 5_000 });

    // 빈 프롬프트 상태에서 Submit 버튼 비활성화 확인
    const submitBtn = page.locator('[data-testid="compose-submit"]');
    await expect(submitBtn).toBeDisabled();

    // 공백만 입력해도 Submit 비활성화 유지
    await composer.locator("textarea").fill("   ");
    await expect(submitBtn).toBeDisabled();

    // 유효한 텍스트 입력 → Submit 활성화
    await composer.locator("textarea").fill("유효한 프롬프트입니다.");
    await expect(submitBtn).toBeEnabled();

    // 다시 비우면 Submit 비활성화
    await composer.locator("textarea").fill("");
    await expect(submitBtn).toBeDisabled();
  });

  // === 멀티턴 세션 렌더링 테스트 ===

  test("21. 멀티턴 세션 — Turn 1 complete 이후 Turn 2 이벤트가 모두 렌더링됨", async ({
    page,
    dashboardServer,
  }) => {
    await page.goto(dashboardServer.baseURL);

    // 세션 목록 로드 (8개: 기존 7 + multiturn)
    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // multiturn 세션 선택
    const multiturnItem = page.locator(
      '[data-testid="session-item-sess-e2e-ui-multiturn"]',
    );
    await multiturnItem.click();

    // SSE 이벤트 전수 수신 대기: user-node가 2개 나타나면 Turn 2까지 수신 완료
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes).toHaveCount(2, { timeout: 15_000 });

    // Turn 1 검증: 첫 번째 USER 노드 존재
    await expect(userNodes.first()).toBeVisible();

    // Turn 2 검증: 두 번째 USER 노드 존재 (이것이 핵심!)
    await expect(userNodes.nth(1)).toBeVisible();

    // system-node: Session Started(root) + result + 2 completes = 4
    const systemNodes = page.locator('[data-testid="system-node"]');
    await expect(systemNodes).toHaveCount(4, { timeout: 15_000 });

    // Turn 2의 tool 노드 검증 (Turn 1: Skill 1개 + Turn 2: 5개 = 총 6개)
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    await expect(toolCallNodes).toHaveCount(6, { timeout: 5_000 });

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/26-multiturn-full-render.png`,
      fullPage: true,
    });
  });

  test("22. 멀티턴 세션 — 세션 상태가 Turn별로 올바르게 전환됨", async ({
    page,
    dashboardServer,
  }) => {
    await page.goto(dashboardServer.baseURL);

    await expect(
      page.locator('[data-testid^="session-item-"]'),
    ).toHaveCount(9, { timeout: 10_000 });

    // multiturn 세션 선택
    const multiturnItem = page.locator(
      '[data-testid="session-item-sess-e2e-ui-multiturn"]',
    );
    await multiturnItem.click();

    // 모든 이벤트 수신 완료 대기: root + result + 2 completes = 4
    const systemNodes = page.locator('[data-testid="system-node"]');
    await expect(systemNodes).toHaveCount(4, { timeout: 15_000 });

    // 최종 상태: Turn 2의 complete 이후이므로 세션 status가 "completed"
    // ChatInput이 "New Chat" 모드여야 함 (Intervention이 아님)
    const chatInput = page.locator('[data-testid="chat-input"]');
    await expect(chatInput).toBeVisible({ timeout: 5_000 });
    await expect(chatInput.locator("text=New Chat")).toBeVisible({ timeout: 5_000 });

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/27-multiturn-status-transition.png`,
      fullPage: true,
    });
  });

  test("23. 캐시 리플레이 — A→B→A 라운드트립 후 그래프 무결성 검증", async ({
    page,
    dashboardServer,
  }) => {
    // === Session A (multi-tool): 첫 로드 (라이브 SSE, 지연 있음) ===
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(300);

    // A1 스냅샷 캡처
    const snapshotA1 = await captureNodeSnapshot(page);

    // 구체 노드 수 검증
    expect(snapshotA1["tool-call-node"]).toBe(3);
    expect(snapshotA1["thinking-node"]).toBe(2);
    expect(snapshotA1["user-node"]).toBe(1);

    // === Session B (no-tool): 전환 ===
    await page
      .locator('[data-testid="session-item-sess-e2e-ui-notool"]')
      .click();

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 10_000 });
    await page.waitForTimeout(300);

    const snapshotB = await captureNodeSnapshot(page);

    // B는 A와 다른 그래프여야 함 (tool 없음)
    expect(snapshotB["tool-call-node"]).toBe(0);
    expect(snapshotB["total"]).not.toBe(snapshotA1["total"]);

    // === Session A 복귀: 캐시 리플레이 (지연 없음, 0ms) ===
    await page
      .locator('[data-testid="session-item-sess-e2e-ui-multi"]')
      .click();

    // 캐시 리플레이: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(300);

    // A2 스냅샷 캡처
    const snapshotA2 = await captureNodeSnapshot(page);

    // === 검증: A1 === A2 ===
    // 총 노드 수 동일
    expect(snapshotA2["total"]).toBe(snapshotA1["total"]);

    // 타입별 노드 수 동일
    for (const key of Object.keys(snapshotA1)) {
      expect(
        snapshotA2[key],
        `${key} mismatch: A1=${snapshotA1[key]} A2=${snapshotA2[key]}`,
      ).toBe(snapshotA1[key]);
    }

    // 구체 노드 수 재검증
    expect(snapshotA2["tool-call-node"]).toBe(3);
    expect(snapshotA2["thinking-node"]).toBe(2);
    expect(snapshotA2["user-node"]).toBe(1);

    // 노드 겹침 없음
    const overlaps = await checkNodeOverlaps(page);
    expect(
      overlaps,
      `노드 겹침: ${JSON.stringify(overlaps)}`,
    ).toHaveLength(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/28-cache-replay-roundtrip.png`,
      fullPage: true,
    });
  });

  test("24. 서브에이전트 노드가 그래프에 렌더링됨", async ({
    page,
    dashboardServer,
  }) => {
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-subagent",
    );

    // Complete까지 대기: Session Started(root) + 2 completes = system-node 3개
    const systemNodes = page.locator('[data-testid="system-node"]');
    await expect(systemNodes).toHaveCount(3, { timeout: 15_000 });

    // User 노드 2개 (Turn 1 + Turn 2)
    const userNodes = page.locator('[data-testid="user-node"]');
    await expect(userNodes).toHaveCount(2, { timeout: 5_000 });

    // Tool 노드 존재 확인 (Skill + Task + Grep = 최소 3개)
    const toolCallNodes = page.locator('[data-testid="tool-call-node"]');
    const toolCount = await toolCallNodes.count();
    expect(toolCount).toBeGreaterThanOrEqual(2); // Task + Skill 최소

    // 전체 노드가 렌더링됨
    const allNodes = page.locator(".react-flow__node");
    const nodeCount = await allNodes.count();
    expect(nodeCount).toBeGreaterThanOrEqual(6);

    // 노드 겹침 없음
    await page.waitForTimeout(500);
    const overlaps = await checkNodeOverlaps(page);
    expect(
      overlaps,
      `노드 겹침: ${JSON.stringify(overlaps)}`,
    ).toHaveLength(0);

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/29-subagent-graph.png`,
      fullPage: true,
    });
  });

  test("25. A→서브에이전트→A 라운드트립 그래프 무결성", async ({
    page,
    dashboardServer,
  }) => {
    // === Session A (multi-tool): 첫 로드 ===
    await navigateAndSelectSession(
      page,
      dashboardServer.baseURL,
      "sess-e2e-ui-multi",
    );

    // Complete까지 대기: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(300);

    const snapshotA1 = await captureNodeSnapshot(page);

    // === Session Subagent: 전환 ===
    await page
      .locator('[data-testid="session-item-sess-e2e-ui-subagent"]')
      .click();

    // Subagent: root + 2 completes = system-node 3개
    const systemNodes = page.locator('[data-testid="system-node"]');
    await expect(systemNodes).toHaveCount(3, { timeout: 15_000 });
    await page.waitForTimeout(300);

    // === Session A 복귀: 캐시 리플레이 ===
    await page
      .locator('[data-testid="session-item-sess-e2e-ui-multi"]')
      .click();

    // 캐시 리플레이: Session Started(root) + Complete = system-node 2개
    await expect(
      page.locator('[data-testid="system-node"]'),
    ).toHaveCount(2, { timeout: 15_000 });
    await page.waitForTimeout(300);

    const snapshotA2 = await captureNodeSnapshot(page);

    // === 검증: A1 === A2 ===
    expect(snapshotA2["total"]).toBe(snapshotA1["total"]);
    for (const key of Object.keys(snapshotA1)) {
      expect(
        snapshotA2[key],
        `${key} mismatch: A1=${snapshotA1[key]} A2=${snapshotA2[key]}`,
      ).toBe(snapshotA1[key]);
    }

    // 스크린샷
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/30-subagent-roundtrip.png`,
      fullPage: true,
    });
  });
});

// === 인증 UI 시나리오 E2E ===

test.describe("인증 UI 시나리오", () => {
  test.beforeEach(() => {
    resetMockAuth();
  });

  test("인증 비활성 → 로그인 없이 바로 대시보드 표시", async ({
    page,
    dashboardServer,
  }) => {
    configureMockAuth({ authEnabled: false, authenticated: false });
    await page.goto(dashboardServer.baseURL);
    // 로그인 페이지 없이 세션 목록이 바로 표시되어야 함
    await expect(page.getByTestId("session-list")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("login-page")).not.toBeVisible();
  });

  test("인증 활성 + 미인증 → 로그인 페이지 표시", async ({
    page,
    dashboardServer,
  }) => {
    configureMockAuth({ authEnabled: true, authenticated: false });
    await page.goto(dashboardServer.baseURL);
    // 로그인 페이지가 표시되어야 함
    await expect(page.getByTestId("login-page")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("google-login-button")).toBeVisible();
    // 세션 목록은 보이지 않아야 함
    await expect(page.getByTestId("session-list")).not.toBeVisible();
  });

  test("dev-login으로 인증 → 대시보드 진입", async ({
    page,
    dashboardServer,
  }) => {
    configureMockAuth({ authEnabled: true, authenticated: false, devModeEnabled: true });
    await page.goto(dashboardServer.baseURL);

    // 로그인 페이지가 표시되어야 함
    await expect(page.getByTestId("login-page")).toBeVisible({ timeout: 8_000 });

    // dev-login 폼 작성 후 제출
    await page.getByTestId("dev-email-input").fill("dev@example.com");
    await page.getByTestId("dev-login-button").click();

    // dev-login 성공 → 대시보드 진입
    await expect(page.getByTestId("session-list")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("login-page")).not.toBeVisible();
  });

  test("로그아웃 → 로그인 페이지로 전환", async ({
    page,
    dashboardServer,
  }) => {
    configureMockAuth({
      authEnabled: true,
      authenticated: true,
      user: { email: "user@example.com", name: "Test User" },
    });
    await page.goto(dashboardServer.baseURL);

    // 대시보드가 표시되어야 함
    await expect(page.getByTestId("session-list")).toBeVisible({ timeout: 8_000 });

    // 로그아웃 버튼 클릭
    await page.getByTestId("logout-button").click();

    // 로그인 페이지로 전환되어야 함
    await expect(page.getByTestId("login-page")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("session-list")).not.toBeVisible();
  });
});

test.describe("모바일 레이아웃", () => {
  test("375px 뷰포트 초기 화면", async ({ page, dashboardServer }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(dashboardServer.baseURL);
    await expect(page.getByTestId("hamburger-button")).toBeVisible();
    await expect(page.getByTestId("connection-badge")).not.toBeAttached();
    await expect(page.getByTestId("session-panel")).not.toBeAttached();
    await expect(page.getByTestId("graph-panel")).not.toBeAttached();
    await expect(page.getByTestId("detail-panel")).not.toBeAttached();
  });

  test("햄버거 버튼 클릭 시 사이드바 슬라이드인", async ({ page, dashboardServer }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(dashboardServer.baseURL);
    await page.getByTestId("hamburger-button").click();
    await expect(page.locator('[data-slot="sheet-backdrop"]')).toBeVisible();
    await expect(page.locator('[data-testid="session-list"] [data-testid^="session-item-"]').first()).toBeVisible();
  });

  test("세션 선택 후 ChatView 전체화면", async ({ page, dashboardServer }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(dashboardServer.baseURL);
    await page.getByTestId("hamburger-button").click();
    await page.locator('[data-testid^="session-item-"]').first().click();
    await expect(page.locator('[data-slot="sheet-backdrop"]')).not.toBeAttached({ timeout: 3000 });
    await expect(page.getByTestId("mobile-main")).toBeVisible();
    await expect(page.getByTestId("graph-panel")).not.toBeAttached();
    await expect(page.getByTestId("detail-panel")).not.toBeAttached();
  });

  test("데스크탑 전환 시 3패널 복원", async ({ page, dashboardServer }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(dashboardServer.baseURL);
    await page.getByTestId("hamburger-button").click();
    await page.locator('[data-testid^="session-item-"]').first().click();
    await expect(page.locator('[data-slot="sheet-backdrop"]')).not.toBeAttached({ timeout: 3000 });
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId("session-panel")).toBeVisible();
    await expect(page.getByTestId("graph-panel")).toBeVisible();
    await expect(page.getByTestId("detail-panel")).toBeVisible();
  });
});
